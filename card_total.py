"""Sum this billing cycle's card approvals via the CODEF API and write summary.json.

Usage:
  python card_total.py register       # one-time: create a connectedId from card-company web logins
  python card_total.py add [names]    # add card accounts to the existing connectedId
  python card_total.py fetch          # sum approvals per card -> summary.json (default)
  python card_total.py kbcard         # generate KB card-check values for Apps Script properties

Passwords are RSA-encrypted with the CODEF public key and never stored.
"""
import base64
import json
import sys
import urllib.parse
from datetime import date
from getpass import getpass
from pathlib import Path

import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding

BASE = Path(__file__).resolve().parent
CONFIG = BASE / "config.json"
STATE = BASE / "state.json"
SUMMARY = BASE / "summary.json"
APPS_SCRIPT_PROPS = BASE / "apps-script-properties.txt"

TOKEN_URL = "https://oauth.codef.io/oauth/token"
API_HOST = {
    "sandbox": "https://sandbox.codef.io",
    "demo": "https://development.codef.io",
    "product": "https://api.codef.io",
}
APPROVAL_PATH = "/v1/kr/card/p/account/approval-list"

EXTRA_LABELS = {
    "userName": "Cardholder's legal name",
    "birthDate": "Birth date, 8 digits (e.g. 19900101)",
    "telecom": "Carrier (0=SKT 1=KT 2=LGU+ 3=MVNO-SKT 4=MVNO-KT 5=MVNO-LGU+)",
    "phoneNo": "Mobile number, digits only (e.g. 01012345678)",
}


def load_json(path, default=None):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def save_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get_token(cfg):
    auth = base64.b64encode(f"{cfg['client_id']}:{cfg['client_secret']}".encode()).decode()
    r = requests.post(
        TOKEN_URL,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data="grant_type=client_credentials&scope=read",
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def call(cfg, token, path, body, timeout=120):
    # CODEF expects a URL-encoded JSON body and returns a URL-encoded JSON response.
    r = requests.post(
        API_HOST[cfg.get("service", "demo")] + path,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=urllib.parse.quote(json.dumps(body)),
        timeout=timeout,
    )
    r.raise_for_status()
    return json.loads(urllib.parse.unquote_plus(r.text))


def encrypt_rsa(plain, public_key_b64):
    pem = "-----BEGIN PUBLIC KEY-----\n" + public_key_b64.strip() + "\n-----END PUBLIC KEY-----"
    key = serialization.load_pem_public_key(pem.encode())
    return base64.b64encode(key.encrypt(plain.encode(), padding.PKCS1v15())).decode()


def account_list(cfg, only=None):
    accounts = []
    for card in cfg["cards"]:
        if only and card["name"] not in only:
            continue
        print(f"[{card['name']}] card-company website login")
        user_id = input("  ID: ").strip()
        password = getpass("  Password (hidden): ")
        account = {
            "countryCode": "KR",
            "businessType": "CD",
            "clientType": "P",
            "organization": card["organization"],
            "loginType": "1",
            "id": user_id,
            "password": encrypt_rsa(password, cfg["public_key"]),
        }
        for field in card.get("extra_fields", []):
            if field == "identity":
                # 7 digits: 6-digit birth date (YYMMDD) + first digit of the RRN back half.
                identity = getpass("  YYMMDD + first digit of RRN back half, 7 digits (hidden): ")
                identity = identity.replace("-", "").strip()
                if not (identity.isdigit() and len(identity) == 7):
                    sys.exit(f"  Expected 7 digits, got {len(identity)}.")
                account[field] = encrypt_rsa(identity, cfg["public_key"])
                account["identityEncYn"] = "Y"
            else:
                account[field] = input(f"  {EXTRA_LABELS.get(field, field)}: ").strip()
        accounts.append(account)
    return accounts


def find_2way(obj):
    """Return the first nested object with continue2Way=true, or None."""
    if isinstance(obj, dict):
        if obj.get("continue2Way") in (True, "true"):
            return obj
        obj = list(obj.values())
    if isinstance(obj, list):
        for value in obj:
            hit = find_2way(value)
            if hit:
                return hit
    return None


def register(cfg, add=False, only=None):
    token = get_token(cfg)
    state = load_json(STATE, {})
    if add and state.get("connectedId"):
        path = "/v1/account/add"
        body = {"connectedId": state["connectedId"], "accountList": account_list(cfg, only)}
    else:
        path = "/v1/account/create"
        body = {"accountList": account_list(cfg, only)}
    res = call(cfg, token, path, body)

    # Extra authentication (e.g. SMS): resend the same request with the code attached.
    for _ in range(3):
        print("  [result code]", (res.get("result") or {}).get("code"))
        print("  [data]", json.dumps(res.get("data"), ensure_ascii=False)[:1500])
        pending = find_2way(res.get("data"))
        if not pending:
            break
        extra_info = json.dumps(pending.get("extraInfo") or {}, ensure_ascii=False)
        print(f"  Additional auth required: {pending.get('method')}  {extra_info}")
        two_way = {
            "is2Way": True,
            "twoWayInfo": {
                k: pending.get(k) for k in ("jobIndex", "threadIndex", "jti", "twoWayTimestamp")
            },
            pending.get("method") or "smsAuthNo": input("  Code sent to your phone: ").strip(),
        }
        # For account registration the 2-way fields go inside the matching accountList entry,
        # not at the top level of the body.
        for account in body["accountList"]:
            if account["organization"] == pending.get("organization"):
                account.update(two_way)
        if pending.get("connectedId") or (res.get("data") or {}).get("connectedId"):
            body["connectedId"] = pending.get("connectedId") or res["data"]["connectedId"]
        print("  Submitting code (may take up to 5 minutes)...")
        res = call(cfg, token, path, body, timeout=300)

    print(json.dumps(res.get("result"), ensure_ascii=False, indent=2))
    data = res.get("data") or {}
    if data.get("connectedId"):
        state["connectedId"] = data["connectedId"]
        save_json(STATE, state)
        print(f"connectedId saved to {STATE.name}")
    for err in data.get("errorList", []) or []:
        print("Failed:", err)


def cycle_start(today, start_day):
    """First day of the current billing cycle, which starts on start_day each month."""
    if today.day >= start_day:
        return today.replace(day=start_day)
    year, month = (today.year, today.month - 1) if today.month > 1 else (today.year - 1, 12)
    return date(year, month, start_day)


def amount(value):
    try:
        return int(float(str(value).replace(",", "") or 0))
    except ValueError:
        return 0


def fetch(cfg):
    state = load_json(STATE, {})
    if not state.get("connectedId"):
        sys.exit("No connectedId found. Run `register` first.")
    token = get_token(cfg)
    today = date.today()
    result = {"updated": today.isoformat(), "cards": [], "total": 0}

    for card in cfg["cards"]:
        start = cycle_start(today, card.get("cycle_start_day", 1))
        body = {
            "organization": card["organization"],
            "connectedId": state["connectedId"],
            "startDate": start.strftime("%Y%m%d"),
            "endDate": today.strftime("%Y%m%d"),
            "orderBy": "0",
            "inquiryType": "1",
            "memberStoreInfoType": "0",
        }
        if card.get("birthDate"):
            body["birthDate"] = card["birthDate"]
        res = call(cfg, token, APPROVAL_PATH, body)
        code = res.get("result", {}).get("code")
        rows = res.get("data") or []
        if isinstance(rows, dict):
            rows = [rows]

        total = 0
        for row in rows:
            # resCancelYN: 0=normal, 1=cancelled, 2=partially cancelled, 3=rejected
            cancel = str(row.get("resCancelYN", "0"))
            if cancel in ("1", "3"):
                continue
            currency = str(row.get("resAccountCurrency") or "KRW").upper()
            if currency != "KRW" and amount(row.get("resKRWAmt")):
                amt = amount(row.get("resKRWAmt"))  # foreign purchase: use the KRW-converted amount
            else:
                amt = amount(row.get("resUsedAmount"))
            if cancel == "2":
                amt -= amount(row.get("resCancelAmount"))
            total += amt

        ok = code == "CF-00000"
        result["cards"].append({
            "name": card["name"],
            "from": start.isoformat(),
            "amount": total,
            "count": len(rows),
            "ok": ok,
            **({} if ok else {"error": res.get("result")}),
        })
        result["total"] += total
        print(f"{card['name']:<6} {start} ~ {today}  {total:>12,} KRW  ({'OK' if ok else code})")

    print(f"{'Total':<6} {'':>25}{result['total']:>12,} KRW")
    save_json(SUMMARY, result)


def kbcard(cfg):
    """Append KB card-possession values for Apps Script Script Properties.

    KB requires a card-possession check (CF-12108) when called from Google's IP
    range, so the Apps Script needs the card number and encrypted PIN digits.
    """
    card_no = getpass("  KB card number, 15-16 digits (hidden): ")
    card_no = card_no.replace("-", "").replace(" ", "").strip()
    pin2 = getpass("  First 2 digits of card PIN (hidden): ").strip()
    if not (card_no.isdigit() and len(card_no) in (15, 16) and pin2.isdigit() and len(pin2) == 2):
        sys.exit("  Card number must be 15-16 digits and PIN must be 2 digits.")
    with open(APPS_SCRIPT_PROPS, "a", encoding="utf-8") as f:
        f.write(
            "\n\nKB_CARD_NO\n" + card_no
            + "\n\nKB_CARD_PW_ENC\n" + encrypt_rsa(pin2, cfg["public_key"]) + "\n"
        )
    print(f"  Done. Add the last two entries in {APPS_SCRIPT_PROPS} to Script Properties.")


def main():
    cfg = load_json(CONFIG)
    if not cfg:
        sys.exit("config.json not found. Copy config.example.json and fill it in.")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "fetch"
    if cmd == "register":
        register(cfg)
    elif cmd == "kbcard":
        kbcard(cfg)
    elif cmd == "add":
        register(cfg, add=True, only=sys.argv[2:] or None)  # e.g. add Lotte KB
    else:
        fetch(cfg)


if __name__ == "__main__":
    main()

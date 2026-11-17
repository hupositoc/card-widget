# card-widget

An Android home-screen widget (KWGT) that shows the current billing cycle's total spend across three Korean credit cards: KB Kookmin, Woori and Lotte. The point is to see one number without opening three card apps.

```
 phone                                Google Apps Script web app            CODEF API
 ------                               --------------------------            ---------
 KWGT widget  --- GET ?key=... --->   doGet  -> JSON (total, ...)
 MacroDroid   --- POST body ------>   doPost -> Lotte: add/subtract amount
                                              -> KB/Woori: refresh now  ---> approval-list
                                      hourly trigger (skips 01-07 KST) ---> approval-list
```

## How it works

KB Kookmin (CODEF organization `0301`) and Woori (`0309`)

- Fetched with the CODEF `approval-list` API from a Google Apps Script web app.
- A time trigger runs every hour and skips 01:00-07:00 KST to save calls.
- When the phone forwards an approval notification that mentions 국민, KB or 우리, the script refreshes right away (1-minute debounce) and schedules one more query 5 minutes later, because new approvals take a while to show up in CODEF.

Lotte (`0311`)

- Registering Lotte on CODEF needs SMS two-way authentication, and it kept timing out (`CF-01004`). So Lotte is tracked from approval texts instead.
- MacroDroid on the phone forwards each approval notification to the web app with a POST.
- The script matches 롯데, 로카, LOCA or 1588-8100 in the text, then adds the amount. Cancellations (취소) subtract, rejections (거절/실패/오류) are ignored, and duplicates are dropped by an MD5 hash of the text.
- The running total resets on the 11th, which is when Lotte's billing cycle starts.
- If the total drifts, correct it manually: `GET .../exec?key=<WIDGET_KEY>&lotteSet=123456`.

## Files

| Path | Purpose |
| --- | --- |
| `card_total.py` | Local CLI for CODEF setup: `register`, `add`, `fetch`, `kbcard` |
| `apps-script/Code.gs` | The web app (doGet, doPost, CODEF calls, Lotte tally, trigger) |
| `apps-script/appsscript.json` | Apps Script manifest (Asia/Seoul, V8, web app settings) |
| `config.example.json` | Template for `config.json` |
| `docs/widget-design.md` | Widget layout, colors and KWGT formulas |

## Setup

### 1. CODEF

1. Create an account at codef.io and get the demo keys (client ID, client secret, public key) from the key management page.
2. Install dependencies:

   ```
   pip install requests cryptography
   ```

3. Copy `config.example.json` to `config.json` and fill in the keys.
4. Register the cards and get a connected ID:

   ```
   python card_total.py register
   ```

   Use `python card_total.py add <card name>` to add a card to an existing connected ID later. `python card_total.py fetch` prints the current totals locally, which is a good check that registration worked.

5. KB requires a card-possession check (`CF-12108`) when called from Google's IPs. Run:

   ```
   python card_total.py kbcard
   ```

   It asks for the card number and the first two digits of the card password (input is hidden), RSA-encrypts the password digits, and appends `KB_CARD_NO` and `KB_CARD_PW_ENC` to `apps-script-properties.txt`.

### 2. Apps Script

1. Create a new Apps Script project. Paste in `apps-script/Code.gs`, and replace the manifest with `apps-script/appsscript.json` (enable "Show appsscript.json" in project settings).
2. Add Script Properties (Project settings -> Script properties):

   | Property | Value |
   | --- | --- |
   | `CLIENT_ID` | CODEF client ID |
   | `CLIENT_SECRET` | CODEF client secret |
   | `CONNECTED_ID` | From `state.json` after `register` |
   | `WIDGET_KEY` | A long random string you generate; acts as the URL password |
   | `KB_CARD_NO` | From `kbcard` |
   | `KB_CARD_PW_ENC` | From `kbcard` |
   | `SERVICE` | Optional: `demo` (default), `product` or `sandbox` |

   One way to generate a key: `python -c "import secrets; print(secrets.token_urlsafe(32))"`

3. Run `installTrigger` once from the editor and approve the permissions. This creates the hourly trigger.
4. Deploy -> New deployment -> Web app. Execute as: me. Who has access: anyone. Copy the `/exec` URL.
5. Test in a browser: `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?key=<WIDGET_KEY>`

When you change the code later, use Deploy -> Manage deployments -> Edit (pencil) -> Version: New version. Creating a new deployment instead gives you a new URL, and the widget and macro would both need updating.

### 3. MacroDroid

Create one macro:

- Trigger: Notification received. App: your messages app. Text contains: `승인`.
- Action: HTTP request, method POST, URL `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`, content type `text/plain`, body:

  ```
  <WIDGET_KEY> {not_title} {not_text}
  ```

### 4. KWGT

Make a widget that reads `totalText` from the web app. Layout, colors and the exact formulas are in [docs/widget-design.md](docs/widget-design.md).

## Response format

`doGet` returns JSON:

| Field | Meaning |
| --- | --- |
| `total` | Total across all cards, as a number |
| `totalText` | Same, formatted, e.g. `1,234,567원` |
| `detailText` | Per-card summary, e.g. `국민 ...원 · 우리 ...원 · 롯데 ...원` (a warning mark if a card failed) |
| `updated` | When CODEF was last queried |
| `lotteLast` | Last Lotte change, e.g. `11/17 12:30 +15,000원` |
| `lastPost` | Diagnostics for the last POST: time, whether it was authorized, length, a short preview, result |
| `cards[]` | `{ name, amount, ok }` per card |

## Gotchas

- Card approval texts are usually long `[Web발신]` LMS messages. MacroDroid's "SMS received" trigger does not fire for them. Use "Notification received" on the messages app.
- MacroDroid drops the query string on POST requests, so `?key=` never arrives. That is why the key goes at the start of the POST body. `doPost` accepts either.
- Apps Script answers a POST with a 302 redirect. That is normal; the request has already been processed. Check `lastPost` in the GET response if you are unsure whether it arrived.
- KWGT caches `$wg()$` results per URL. If the widget seems stuck after a redeploy, change `&v=1` to `&v=2` in the URL to force a fresh fetch.
- CODEF warns that IPs making too many requests can be blocked. Keep the polling interval reasonable; the hourly trigger plus the night skip and the debounce are there for this reason.
- `CF-12108` on KB means the card-possession check is missing. See setup step 1.5.

## Privacy

- `config.json`, `state.json`, `summary.json` and `apps-script-properties.txt` contain API keys, connected IDs or personal data. They are in `.gitignore`. Do not commit them.
- Card passwords are never stored in plain text. They are RSA-encrypted with the CODEF public key before being sent or saved (`KB_CARD_PW_ENC`).
- The widget key is a shared secret that appears in the URL. Anyone with the URL can read your totals and change the Lotte total, so treat your KWGT preset and MacroDroid macro as private and do not share exports of them.

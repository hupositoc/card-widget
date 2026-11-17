/**
 * Card spending for the current billing cycle, served as JSON for a KWGT widget.
 *   - KB Kookmin, Woori: fetched from the CODEF approval-list API (hourly trigger,
 *     plus on demand when the phone forwards an approval notification).
 *   - Lotte: accumulated from forwarded SMS/notification text, reset on the 11th.
 *
 * Script Properties:
 *   CLIENT_ID, CLIENT_SECRET   CODEF API credentials
 *   CONNECTED_ID               CODEF connected ID holding the card logins
 *   WIDGET_KEY                 shared secret for doGet/doPost
 *   KB_CARD_NO, KB_CARD_PW_ENC optional, for KB's card-possession check
 *   SERVICE                    optional: sandbox | demo (default) | product
 */

var CODEF_CARDS = [
  { name: '국민', organization: '0301', cycleStartDay: 1 },
  { name: '우리', organization: '0309', cycleStartDay: 1 },
];
var LOTTE_CYCLE_START_DAY = 11;

var HOSTS = {
  sandbox: 'https://sandbox.codef.io',
  demo: 'https://development.codef.io',
  product: 'https://api.codef.io',
};
var APPROVAL_PATH = '/v1/kr/card/p/account/approval-list';
var TZ = 'Asia/Seoul';

function props_() { return PropertiesService.getScriptProperties(); }
function getJson_(key, fallback) { var v = props_().getProperty(key); return v ? JSON.parse(v) : fallback; }
function setJson_(key, value) { props_().setProperty(key, JSON.stringify(value)); }
function ymd_(date) { return Utilities.formatDate(date, TZ, 'yyyyMMdd'); }
function num_(v) { return parseInt(String(v || '0').replace(/,/g, ''), 10) || 0; }
function won_(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원'; }
function now_(pattern) { return Utilities.formatDate(new Date(), TZ, pattern); }

function cycleStart_(today, startDay) {
  var y = Number(Utilities.formatDate(today, TZ, 'yyyy'));
  var m = Number(Utilities.formatDate(today, TZ, 'M')) - 1;
  var d = Number(Utilities.formatDate(today, TZ, 'd'));
  if (d < startDay) m -= 1;
  return new Date(y, m, startDay, 12);
}

// --- CODEF (KB Kookmin, Woori) ---

function getToken_() {
  var p = props_();
  var auth = Utilities.base64Encode(p.getProperty('CLIENT_ID') + ':' + p.getProperty('CLIENT_SECRET'));
  var res = UrlFetchApp.fetch('https://oauth.codef.io/oauth/token', {
    method: 'post',
    headers: { Authorization: 'Basic ' + auth },
    contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=client_credentials&scope=read',
  });
  return JSON.parse(res.getContentText()).access_token;
}

// CODEF expects the JSON request body URL-encoded and returns a URL-encoded response.
function call_(token, path, body) {
  var host = HOSTS[props_().getProperty('SERVICE') || 'demo'];
  var res = UrlFetchApp.fetch(host + path, {
    method: 'post',
    headers: { Authorization: 'Bearer ' + token },
    contentType: 'application/json',
    payload: encodeURIComponent(JSON.stringify(body)),
    muteHttpExceptions: true,
  });
  return JSON.parse(decodeURIComponent(res.getContentText().replace(/\+/g, ' ')));
}

function updateCodef() {
  var p = props_();
  var token = getToken_();
  var cid = p.getProperty('CONNECTED_ID');
  var today = new Date();
  var prev = getJson_('CODEF', { cards: [] });
  var out = { updated: Utilities.formatDate(today, TZ, 'MM/dd HH:mm'), cards: [] };

  CODEF_CARDS.forEach(function (card, i) {
    var body = {
      organization: card.organization,
      connectedId: cid,
      startDate: ymd_(cycleStart_(today, card.cycleStartDay)),
      endDate: ymd_(today),
      orderBy: '0',
      inquiryType: '1',
      memberStoreInfoType: '0',
    };
    // KB may demand a card-possession check (CF-12108): it needs the full card
    // number as loginCardNo/cardNo plus the RSA-encrypted first two PIN digits.
    if (card.organization === '0301' && p.getProperty('KB_CARD_NO')) {
      body.loginCardNo = p.getProperty('KB_CARD_NO');
      body.cardNo = p.getProperty('KB_CARD_NO');
      body.cardPassword = p.getProperty('KB_CARD_PW_ENC');
    }
    var res = call_(token, APPROVAL_PATH, body);
    var code = res.result && res.result.code;
    var entry = { name: card.name, amount: 0, ok: code === 'CF-00000' };
    if (entry.ok) {
      var rows = res.data || [];
      if (!Array.isArray(rows)) rows = [rows];
      rows.forEach(function (r) {
        // resCancelYN: 0 = normal, 1 = cancelled, 2 = partially cancelled, 3 = declined
        var cancel = String(r.resCancelYN || '0');
        if (cancel === '1' || cancel === '3') return;
        var currency = String(r.resAccountCurrency || 'KRW').toUpperCase();
        var amount = (currency !== 'KRW' && num_(r.resKRWAmt)) ? num_(r.resKRWAmt) : num_(r.resUsedAmount);
        if (cancel === '2') amount -= num_(r.resCancelAmount);
        entry.amount += amount;
      });
    } else {
      // Keep the last known amount so a transient error doesn't zero the widget.
      var old = (prev.cards || [])[i];
      entry.amount = old ? old.amount : 0;
      entry.error = code + ' ' + (res.result && res.result.message);
      console.warn(card.name, entry.error);
    }
    out.cards.push(entry);
  });
  setJson_('CODEF', out);
  console.log(JSON.stringify(out));
}

// Called when a KB/Woori notification arrives: refresh now, then once more in
// 5 minutes because new approvals can take a while to show up in CODEF.
function refreshCodefNow_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { ok: true, reason: 'codef refresh already running' };
  try {
    // One purchase often produces several notifications.
    var last = Number(props_().getProperty('CODEF_LAST_RUN') || 0);
    if (Date.now() - last < 60 * 1000) return { ok: true, reason: 'codef refreshed <1min ago' };
    props_().setProperty('CODEF_LAST_RUN', String(Date.now()));
    updateCodef();
  } finally {
    lock.releaseLock();
  }
  scheduleFollowup_();
  return { ok: true, reason: 'codef refreshed' };
}

function scheduleFollowup_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'codefFollowup';
  });
  if (!exists) ScriptApp.newTrigger('codefFollowup').timeBased().after(5 * 60 * 1000).create();
}

// One-shot trigger handler; removes its own trigger before running.
function codefFollowup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'codefFollowup') ScriptApp.deleteTrigger(t);
  });
  props_().setProperty('CODEF_LAST_RUN', String(Date.now()));
  updateCodef();
}

// --- Lotte (SMS) ---
// Lotte is tracked from approval messages forwarded by the phone rather than
// through CODEF. Messages may use the brand name "LOCA" (로카) instead of 롯데.

var LOTTE_RE = /롯데|로카|LOCA|1588-?8100/i;

// Returns { amount, cancel } or null if the text isn't a Lotte approval.
function parseLotteSms_(text) {
  var t = String(text || '');
  if (!LOTTE_RE.test(t)) return null;
  if (/거절|실패|오류/.test(t)) return null;
  var m = t.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*원/);
  if (!m) return null;
  return { amount: num_(m[1]), cancel: /취소/.test(t) };
}

// The running total starts over when the billing cycle (from the 11th) changes.
function lotteState_() {
  var start = ymd_(cycleStart_(new Date(), LOTTE_CYCLE_START_DAY));
  var s = getJson_('LOTTE', null);
  if (!s || s.cycle !== start) s = { cycle: start, total: 0, seen: [], last: '' };
  return s;
}

function addLotteSms_(text) {
  var parsed = parseLotteSms_(text);
  if (!parsed) return { ok: false, reason: 'not a Lotte approval sms' };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var s = lotteState_();
    // The same message can be forwarded more than once; dedupe by hash.
    var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, text));
    if (s.seen.indexOf(hash) >= 0) return { ok: true, duplicate: true, total: s.total };
    s.seen.push(hash);
    if (s.seen.length > 300) s.seen = s.seen.slice(-300);
    s.total += parsed.cancel ? -parsed.amount : parsed.amount;
    s.last = now_('MM/dd HH:mm') + (parsed.cancel ? ' 취소 -' : ' +') + won_(parsed.amount);
    setJson_('LOTTE', s);
    return { ok: true, total: s.total, last: s.last };
  } finally {
    lock.releaseLock();
  }
}

// --- Web app ---

function summary_() {
  var codef = getJson_('CODEF', { updated: '-', cards: [] });
  var lotte = lotteState_();
  var cards = codef.cards.concat([{ name: '롯데', amount: lotte.total, ok: true }]);
  var total = cards.reduce(function (sum, c) { return sum + c.amount; }, 0);
  return {
    total: total,
    totalText: won_(total),
    detailText: cards.map(function (c) {
      return c.name + ' ' + won_(c.amount) + (c.ok ? '' : '⚠');
    }).join(' · '),
    updated: codef.updated,
    lotteLast: lotte.last,
    lastPost: getJson_('LAST_POST', null),
    cards: cards,
  };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function authorized_(e) {
  return !!(e && e.parameter && e.parameter.key === props_().getProperty('WIDGET_KEY'));
}

// GET ?key=WIDGET_KEY             -> summary
// GET ?key=WIDGET_KEY&lotteSet=N  -> overwrite the Lotte total, then summary
function doGet(e) {
  if (!authorized_(e)) return json_({ error: 'unauthorized' });
  if (e.parameter.lotteSet !== undefined) {
    var s = lotteState_();
    s.total = num_(e.parameter.lotteSet);
    s.last = now_('MM/dd HH:mm') + ' 수동설정';
    setJson_('LOTTE', s);
  }
  return json_(summary_());
}

// POST body: the forwarded message text, prefixed with WIDGET_KEY.
// MacroDroid drops the query string on POST, so ?key= alone can't be relied on.
function doPost(e) {
  var text = (e && e.postData && e.postData.contents) || (e && e.parameter && e.parameter.text) || '';
  var auth = authorized_(e);
  var key = props_().getProperty('WIDGET_KEY');
  if (key && text.indexOf(key) === 0) {
    auth = true;
    text = text.slice(key.length).trim();
  }
  var r;
  if (!auth) r = { error: 'unauthorized' };
  else if (/국민|KB|우리/i.test(text) && !LOTTE_RE.test(text)) r = refreshCodefNow_();
  else r = addLotteSms_(text);
  // Record the last POST for debugging; exposed as lastPost in doGet.
  setJson_('LAST_POST', {
    at: now_('MM/dd HH:mm:ss'),
    auth: auth,
    len: text.length,
    preview: text.slice(0, 15),
    result: r.reason || r.error || (r.duplicate ? 'duplicate' : 'added'),
  });
  console.log('doPost', JSON.stringify(r));
  return json_(r);
}

// --- Triggers and manual tests ---

// Hourly, skipping 01:00-06:59 KST to save API calls.
function codefHourly() {
  var h = Number(now_('H'));
  if (h >= 1 && h < 7) return;
  updateCodef();
}

// Run once by hand to (re)install the hourly trigger.
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'updateCodef' || f === 'codefHourly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('codefHourly').timeBased().everyHours(1).create();
}

// Logs parse results for sample messages; does not store anything.
function testParse() {
  [
    '[Web발신] 롯데카드 승인 홍*동 12,345원 일시불 11/17 13:05 스타벅스',
    '[Web발신] 롯데카드 승인취소 홍*동 12,345원 11/17 13:10 스타벅스',
    '[Web발신] 롯데카드 승인거절 홍*동 5,000원 한도초과',
  ].forEach(function (t) { console.log(t, '=>', JSON.stringify(parseLotteSms_(t))); });
}

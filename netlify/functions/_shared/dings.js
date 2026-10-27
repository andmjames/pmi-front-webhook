// PMI Tape — "Daily Ding" / "Monthly Bottom Line Ding" email → SMS text
//
// Both emails come from Zoho Analytics to andrew@pmitape.com around 4pm on
// weekdays. A Front rule sends them to the webhook; the pipeline calls
// handleDingEmail(), which parses the numbers and texts them.

const { sendToMany, localParts, ANDREW, GROUP } = require("./sms");

const DAILY_DING_SUBJECT   = /^\s*daily ding\s*$/i;
const MONTHLY_DING_SUBJECT = /^\s*monthly bottom line ding\s*$/i;

function stripHtml(html) {
  return (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

// Money-looking numbers: 25,414.76  -1,234.56  (1,234.56)  0.00
function extractAmounts(text) {
  const out = [];
  const re = /\(?-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let s = m[0].replace(/\$/g, "");
    if (s.startsWith("(") && s.endsWith(")")) s = "-" + s.slice(1, -1);
    out.push(s);
  }
  return out;
}

function messageText(msg) {
  return (msg.text && msg.text.trim()) ? msg.text : stripHtml(msg.body);
}

// Returns { kind, body, recipients } or null if this isn't a Ding email / parse failed.
function buildDingMessage(subject, msg) {
  const text = messageText(msg);
  const amounts = extractAmounts(text);

  if (DAILY_DING_SUBJECT.test(subject)) {
    if (amounts.length < 2) { console.error(`Daily Ding: expected 2 amounts, found ${amounts.length} in: ${text.slice(0, 200)}`); return null; }
    return { kind: "daily", body: `${amounts[0]},${amounts[1]}`, recipients: GROUP };
  }
  if (MONTHLY_DING_SUBJECT.test(subject)) {
    if (amounts.length < 1) { console.error(`Monthly Ding: no amount found in: ${text.slice(0, 200)}`); return null; }
    return { kind: "monthly", body: `CMBL: ${amounts[amounts.length - 1]}`, recipients: [ANDREW] };
  }
  return null;
}

function isDingSubject(subject) {
  return DAILY_DING_SUBJECT.test(subject || "") || MONTHLY_DING_SUBJECT.test(subject || "");
}

// Called from the pipeline. Returns true if the email was a Ding (handled or not).
async function handleDingEmail(subject, msg) {
  if (!isDingSubject(subject)) return false;

  const lp = localParts();
  if (!lp.isWeekday) { console.log(`Ding "${subject}" received on ${lp.weekday} — weekend, not texting`); return true; }

  const built = buildDingMessage(subject, msg);
  if (!built) return true;

  console.log(`Ding (${built.kind}) → ${built.recipients.length} recipient(s): ${built.body}`);
  await sendToMany(built.recipients, built.body);
  return true;
}

module.exports = { handleDingEmail, buildDingMessage, isDingSubject, extractAmounts, stripHtml };

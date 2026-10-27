// PMI Tape — preview (and optionally test-send) each SMS in a browser
//
//   /.netlify/functions/sms-preview?which=forecast
//   /.netlify/functions/sms-preview?which=daily
//   /.netlify/functions/sms-preview?which=monthly
//   /.netlify/functions/sms-preview?which=weekly
//
// Add &send=1&key=<SMS_PREVIEW_KEY> to actually send that message to YOUR
// number only (never the group). Set SMS_PREVIEW_KEY in Netlify env to enable.

const https = require("https");
const { sendSms, ANDREW } = require("./_shared/sms");
const { fetchTomorrow, buildForecastMessage } = require("./_shared/weather");
const { buildDingMessage } = require("./_shared/dings");
const { MESSAGE: WEEKLY_MESSAGE } = require("./weekly-budget-sms");

const FRONT_API_BASE = "https://api2.frontapp.com";
const FRONT_API_TOKEN = process.env.FRONT_API_TOKEN;

function frontGet(path) {
  return new Promise((resolve, reject) => {
    https.get(`${FRONT_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${FRONT_API_TOKEN}`, Accept: "application/json" },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) return reject(new Error(`Front ${res.statusCode} ${path}: ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// Newest conversation whose subject is exactly `subject`, plus its latest message.
async function latestDing(subject) {
  const q = encodeURIComponent(`"${subject}"`);
  const search = await frontGet(`/conversations/search/${q}?limit=20`);
  const convs = (search._results || [])
    .filter(c => (c.subject || "").trim().toLowerCase() === subject.toLowerCase())
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  if (!convs.length) throw new Error(`No conversation with subject "${subject}" found`);
  const conv = convs[0];
  const msgs = await frontGet(`/conversations/${conv.id}/messages`);
  const list = msgs._results || [];
  const msg = list[list.length - 1];
  if (!msg) throw new Error(`No messages in ${conv.id}`);
  return { conv, msg };
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const which = (p.which || "").toLowerCase();
  const text = (s) => ({ statusCode: 200, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: s });

  try {
    let body, meta = "";
    if (which === "forecast") {
      const fc = await fetchTomorrow();
      body = buildForecastMessage(fc);
      meta = `(tomorrow ${fc.tomorrowDate}: 6am ${fc.sixAmF}F, high ${fc.highF}F, code ${fc.code})`;
    } else if (which === "daily" || which === "monthly") {
      const subject = which === "daily" ? "Daily Ding" : "Monthly Bottom Line Ding";
      const { conv, msg } = await latestDing(subject);
      const built = buildDingMessage(subject, msg);
      if (!built) throw new Error("Could not parse amounts from the latest email");
      body = built.body;
      const when = new Date((conv.created_at || 0) * 1000).toLocaleString("en-US", { timeZone: "America/Indiana/Indianapolis" });
      meta = `(from ${conv.id}, received ${when}; would go to ${built.recipients.length} recipient(s))`;
    } else if (which === "weekly") {
      body = WEEKLY_MESSAGE;
      meta = "(Fridays 4pm, 3 recipients)";
    } else {
      return text("Usage: ?which=forecast | daily | monthly | weekly   (add &send=1&key=... to test-send to Andrew only)");
    }

    let sentNote = "";
    if (p.send === "1") {
      const key = process.env.SMS_PREVIEW_KEY;
      if (!key || p.key !== key) sentNote = "\n\nNOT SENT: send=1 requires a matching &key= (SMS_PREVIEW_KEY env var).";
      else { await sendSms(ANDREW, body); sentNote = `\n\nSENT to ${ANDREW}.`; }
    }

    // Preview shows EXACTLY what the text message will contain.
    // Details go to the function log instead.
    console.log(`sms-preview ${which} ${meta}`);
    return text(`${body}${sentNote}`);
  } catch (e) {
    return text(`ERROR: ${e.message}`);
  }
};

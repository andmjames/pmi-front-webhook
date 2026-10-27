// PMI Tape — Twilio SMS helper + shared time utilities
//
// Env vars (Netlify → Site configuration → Environment variables):
//   TWILIO_ACCOUNT_SID   ACxxxxxxxx
//   TWILIO_AUTH_TOKEN    your auth token
//   TWILIO_FROM          the Twilio number to send from, E.164 (+13175551234)

const https = require("https");
const qs = require("querystring");

const TZ = "America/Indiana/Indianapolis";

// ── Recipients ────────────────────────────────────────────────────────────────
const ANDREW = "+13175908406";
const GROUP  = ["+13175908406", "+13175068915", "+13176455216"];

// ── Local-time helpers (DST-safe) ─────────────────────────────────────────────
// Netlify cron runs in UTC, so schedules are set for BOTH possible UTC hours and
// the function checks the real Indiana hour before acting.
function localParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return {
    hour: Number(parts.hour) % 24,
    weekday: parts.weekday,                          // "Mon".."Sun"
    isWeekday: !["Sat", "Sun"].includes(parts.weekday),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// ── Twilio ────────────────────────────────────────────────────────────────────
function sendSms(to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM;
  if (!sid || !token || !from) {
    return Promise.reject(new Error("Twilio env vars missing (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM)"));
  }
  const data = Buffer.from(qs.stringify({ To: to, From: from, Body: body }));
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.twilio.com", port: 443,
      path: `/2010-04-01/Accounts/${sid}/Messages.json`, method: "POST",
      auth: `${sid}:${token}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": data.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 200 && res.statusCode < 300) {
          let sidOut = "?"; try { sidOut = JSON.parse(text).sid; } catch {}
          console.log(`SMS sent to ${to} (${sidOut})`);
          resolve(true);
        } else {
          reject(new Error(`Twilio ${res.statusCode}: ${text.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Send to several numbers; never throws, reports per-number results.
async function sendToMany(recipients, body) {
  const results = [];
  for (const to of recipients) {
    try { await sendSms(to, body); results.push({ to, ok: true }); }
    catch (e) { console.error(`SMS to ${to} failed: ${e.message}`); results.push({ to, ok: false, error: e.message }); }
  }
  return results;
}

module.exports = { sendSms, sendToMany, localParts, ANDREW, GROUP, TZ };

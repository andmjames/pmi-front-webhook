// PMI Tape — nightly forecast text (8:00 PM Indiana time, every day)
//
// Schedule (netlify.toml): "0 0,1 * * *" UTC = 8pm EDT and 8pm EST.
// Only the run whose local hour is 20 actually sends; the other exits.

const { sendSms, localParts, ANDREW } = require("./_shared/sms");
const { fetchTomorrow, buildForecastMessage } = require("./_shared/weather");

exports.handler = async () => {
  const lp = localParts();
  if (lp.hour !== 20) {
    console.log(`forecast-sms: local hour is ${lp.hour}, not 20 — skipping (DST guard)`);
    return { statusCode: 200, body: "skip" };
  }
  try {
    const fc = await fetchTomorrow();
    const body = buildForecastMessage(fc);
    console.log(`forecast-sms for ${fc.tomorrowDate}:\n${body}`);
    await sendSms(ANDREW, body);
    return { statusCode: 200, body: "sent" };
  } catch (e) {
    console.error(`forecast-sms error: ${e.message}`);
    return { statusCode: 200, body: "error" };
  }
};

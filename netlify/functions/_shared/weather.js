// PMI Tape — tomorrow's forecast for Fishers, IN + attire rules
// Data: Open-Meteo (free, no key). Times are already in Indiana local time.

const https = require("https");

const FISHERS = { lat: 39.9568, lon: -86.0133 };
const TZ = "America/Indiana/Indianapolis";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode !== 200) return reject(new Error(`weather ${res.statusCode}: ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// WMO weather codes → plain words
function describeCode(code) {
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly Clear";
  if (code === 2) return "Partly Cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Foggy";
  if (code >= 51 && code <= 57) return "Drizzly";
  if (code >= 61 && code <= 67) return "Rainy";
  if (code >= 71 && code <= 77) return "Snowy";
  if (code >= 80 && code <= 82) return "Rain Showers";
  if (code === 85 || code === 86) return "Snow Showers";
  if (code >= 95) return "Thunderstorms";
  return "Mixed";
}

// One-word feel, from the day's high
function describeFeel(highF) {
  if (highF <= 32) return "Freezing";
  if (highF < 45)  return "Cold";
  if (highF < 60)  return "Chilly";
  if (highF <= 77) return "Mild";
  if (highF < 88)  return "Warm";
  return "Hot";
}

// ── Attire cutoffs (exactly as specified) ─────────────────────────────────────
function runningAttire(tempF) {
  if (tempF < 40.005) return "a sweatshirt, warm sweatpants, and gloves";        // below 40.00
  if (tempF <= 50.00) return "a sweatshirt and warm sweatpants. No gloves.";     // 40.01–50.00
  if (tempF <= 60.00) return "a long sleeve t-shirt and light sweatpants";       // 50.01–60.00
  return "shorts and a t-shirt";                                                  // above 60.01
}
function dailyAttire(highF) {
  if (highF < 60.005) return "jeans and a quarter-zip";                          // below 60.00
  if (highF <= 77.00) return "jeans and a polo";                                 // 60.01–77.00
  return "shorts and a polo";                                                     // above 77.01
}

async function fetchTomorrow() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${FISHERS.lat}&longitude=${FISHERS.lon}`
    + `&hourly=temperature_2m&daily=weather_code,temperature_2m_max`
    + `&temperature_unit=fahrenheit&timezone=${encodeURIComponent(TZ)}&forecast_days=2`;
  const d = await fetchJson(url);

  const tomorrowDate = d.daily.time[1];
  const highF = d.daily.temperature_2m_max[1];
  const code  = d.daily.weather_code[1];

  // 6:00 AM tomorrow, local time
  const idx = d.hourly.time.findIndex(t => t === `${tomorrowDate}T06:00`);
  if (idx < 0) throw new Error("6am slot not found in hourly forecast");
  const sixAmF = d.hourly.temperature_2m[idx];

  return { tomorrowDate, highF, code, sixAmF };
}

function buildForecastMessage({ highF, code, sixAmF }) {
  const run = runningAttire(sixAmF);
  const runLine = `Wear ${run}${run.endsWith(".") ? "" : "."}`;
  return [
    `Tomorrow will be ${describeCode(code)}. ${describeFeel(highF)}.`,
    ``,
    `For tomorrow's run, it will be ${Math.round(sixAmF)}F. ${runLine}`,
    ``,
    `For the day tomorrow, the high will be ${Math.round(highF)}F. Wear ${dailyAttire(highF)}`,
  ].join("\n");
}

module.exports = { fetchTomorrow, buildForecastMessage, runningAttire, dailyAttire, describeCode, describeFeel };

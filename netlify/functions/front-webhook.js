// PMI Tape — Front App Webhook FRONT DOOR (v16)
// Returns 200 to Front in well under a second, then hands the slow pipeline to
// front-webhook-background.js. This eliminates the 5001ms/499 timeouts that were
// causing Front to disable the webhook.
//
// ALL logic lives in _shared/pipeline.js — edit detection there, not here.

const https = require("https");
const { parseFrontEvent } = require("./_shared/pipeline");

const SITE_URL = process.env.URL || "https://pmiorderemail.netlify.app";
const BACKGROUND_PATH = "/.netlify/functions/front-webhook-background";

function triggerBackground(bodyObj) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(bodyObj));
    const url = new URL(SITE_URL + BACKGROUND_PATH);
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": data.length },
    }, (res) => { res.on("data", () => {}); res.on("end", () => resolve(true)); });
    req.on("error", (e) => { console.error(`triggerBackground error: ${e.message}`); resolve(false); });
    req.write(data);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "GET") {
    return { statusCode: 200, body: "PMI Tape Front Webhook v16 — OK" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "OK" };
  }

  // Front verification challenge — echo synchronously.
  const challenge = event.headers["x-front-challenge"] || event.headers["X-Front-Challenge"];
  if (challenge) {
    console.log("Challenge received");
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge }) };
  }

  const parsed = parseFrontEvent(event.body);
  if (parsed.error || !parsed.conversationId) {
    return { statusCode: 200, body: "Ignored" };
  }

  await triggerBackground({ conversationId: parsed.conversationId, isManualTag: parsed.isManualTag });
  console.log(`Handed off ${parsed.conversationId} to background worker`);
  return { statusCode: 200, body: "Accepted" };
};

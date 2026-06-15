// PMI Tape — Front App Webhook Handler v7
// Synchronous — does all work within the request, optimized to stay under 5s.
// Manual tag path: skips Claude, runs in ~2-3s.
// Auto-detect path: Claude classification adds ~1-2s.

const https = require("https");
const crypto = require("crypto");

const FRONT_API_BASE       = "https://api2.frontapp.com";
const SUPABASE_URL         = "https://zhvfcipveeeybczzmues.supabase.co";
const SUPABASE_BUCKET      = "purchase-orders";
const ORDER_ENTRY_APP      = "https://pmiorder.netlify.app";
const CUSTOMER_ORDER_TAG   = "Customer Order";
const ORDERS_INBOX_ADDRESS = "customerservice@pmitape.com";
const ACCEPTED_ATTACHMENT_TYPES = [
  "application/pdf","image/jpeg","image/jpg",
  "image/png","image/gif","image/webp","image/tiff",
];

const FRONT_API_TOKEN    = process.env.FRONT_API_TOKEN;
const FRONT_WEBHOOK_SECRET = process.env.FRONT_WEBHOOK_SECRET;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(method, urlStr, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const bodyData = body !== null
      ? (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body)))
      : null;
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: { ...headers, ...(bodyData ? { "Content-Length": bodyData.length } : {}) },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, raw, body: raw.toString("utf8") });
      });
    });
    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

// ── Front API ─────────────────────────────────────────────────────────────────
const fh = () => ({
  Authorization: `Bearer ${FRONT_API_TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json",
});

async function getConversation(id) {
  const r = await request("GET", `${FRONT_API_BASE}/conversations/${id}`, fh());
  if (r.status !== 200) throw new Error(`getConversation ${r.status}: ${r.body}`);
  return JSON.parse(r.body);
}

async function getMessages(id) {
  const r = await request("GET", `${FRONT_API_BASE}/conversations/${id}/messages`, fh());
  if (r.status !== 200) throw new Error(`getMessages ${r.status}: ${r.body}`);
  return JSON.parse(r.body);
}

async function downloadAttachment(url) {
  const r = await request("GET", url, { Authorization: `Bearer ${FRONT_API_TOKEN}` });
  if (r.status !== 200) throw new Error(`downloadAttachment ${r.status}`);
  return r.raw;
}

async function postComment(conversationId, comment) {
  const r = await request(
    "POST", `${FRONT_API_BASE}/conversations/${conversationId}/comments`,
    fh(), JSON.stringify({ author_id: "tea_jloke", body: comment })
  );
  if (![200,201,204].includes(r.status)) throw new Error(`postComment ${r.status}: ${r.body}`);
}

async function alreadyCommented(conversationId) {
  const r = await request("GET", `${FRONT_API_BASE}/conversations/${conversationId}/comments`, fh());
  if (r.status !== 200) return false;
  const data = JSON.parse(r.body);
  return (data._results || data.results || []).some(c => c.body?.includes("Order identified"));
}

// ── Supabase ──────────────────────────────────────────────────────────────────
const sh = () => ({
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
});

async function uploadToSupabase(fileBuffer, fileName, contentType) {
  const check = await request("GET", `${SUPABASE_URL}/storage/v1/bucket/${SUPABASE_BUCKET}`, sh());
  if (check.status !== 200) {
    await request("POST", `${SUPABASE_URL}/storage/v1/bucket`,
      { ...sh(), "Content-Type": "application/json" },
      JSON.stringify({ id: SUPABASE_BUCKET, name: SUPABASE_BUCKET, public: true })
    );
  }
  const r = await request("POST",
    `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${fileName}`,
    { ...sh(), "Content-Type": contentType, "x-upsert": "true" },
    fileBuffer
  );
  if (![200,201].includes(r.status)) throw new Error(`uploadToSupabase ${r.status}: ${r.body}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${fileName}`;
}

// ── Email body capture ────────────────────────────────────────────────────────
function buildEmailText(conversation, message) {
  const from = message.from ? `${message.from.name || ""} <${message.from.handle || ""}>`.trim() : "Unknown";
  const date = message.created_at
    ? new Date(message.created_at * 1000).toLocaleString("en-US", { timeZone: "America/Indiana/Indianapolis" })
    : "Unknown";
  return Buffer.from([
    `FROM:    ${from}`,
    `TO:      ${ORDERS_INBOX_ADDRESS}`,
    `DATE:    ${date}`,
    `SUBJECT: ${conversation.subject || ""}`,
    "", "─────────────────────────────────────────────────", "",
    message.text || message.body || "(no body)",
  ].join("\n"), "utf8");
}

// ── Claude classification ─────────────────────────────────────────────────────
async function isOrderEmail(subject, body, sender) {
  const r = await request(
    "POST", "https://api.anthropic.com/v1/messages",
    { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{ role: "user", content:
        `Is this email a customer purchase order or product order request to PMI Tape?\n\nFROM: ${sender}\nSUBJECT: ${subject}\nBODY: ${body.slice(0,1500)}\n\nReply ONLY: {"is_order":true} or {"is_order":false}`
      }],
    })
  );
  if (r.status !== 200) { console.error(`Claude failed: ${r.status}`); return false; }
  try {
    const text = JSON.parse(r.body).content?.[0]?.text || "{}";
    const result = JSON.parse(text.replace(/```json|```/g,"").trim());
    console.log(`Claude: ${JSON.stringify(result)}`);
    return result.is_order === true;
  } catch { return false; }
}

// ── Signature verification ────────────────────────────────────────────────────
function verifySignature(rawBody, sig) {
  if (!FRONT_WEBHOOK_SECRET) return true;
  if (!sig) return false;
  const expected = crypto.createHmac("sha1", FRONT_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // Health check
  if (event.httpMethod === "GET") {
    return { statusCode: 200, body: "PMI Tape Front Webhook v7 — OK" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "OK" };
  }

  // Front verification challenge
  const challenge = event.headers["x-front-challenge"] || event.headers["X-Front-Challenge"];
  if (challenge) {
    console.log("Challenge received");
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge }) };
  }

  // Parse
  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 200, body: "Bad JSON" }; }

  const eventType = payload.type;
  const eventData = payload.payload || {};
  console.log(`Event: ${eventType}`);

  // Determine conversation and trigger type
  let conversationId = null;
  let isManualTag = false;

  if (eventType === "inbound_received" || eventType === "inbound") {
    conversationId = eventData.conversation?.id || eventData.id;
    console.log(`Inbound conv: ${conversationId}`);
  }

  if (eventType === "tag_added" || eventType === "tag") {
    const tagName = eventData.target?.data?.name || eventData.tag?.name || "";
    const convId = typeof eventData.conversation === "string"
      ? eventData.conversation : (eventData.conversation?.id || "");
    console.log(`Tag: "${tagName}", conv: "${convId}"`);
    if (tagName === CUSTOMER_ORDER_TAG) {
      conversationId = convId;
      isManualTag = true;
    }
  }

  if (!conversationId) {
    return { statusCode: 200, body: "Ignored" };
  }

  // ── Do all work synchronously within the request ──────────────────────────
  try {
    const [conversation, messagesData] = await Promise.all([
      getConversation(conversationId),
      getMessages(conversationId),
    ]);

    const messages = messagesData._results || messagesData.results || [];
    if (!messages.length) {
      console.log("No messages");
      return { statusCode: 200, body: "No messages" };
    }

    const msg = messages[messages.length - 1];
    const subject = conversation.subject || "";
    const bodyText = msg.text || msg.body || "";
    const sender = msg.from?.handle || "unknown";

    if (await alreadyCommented(conversationId)) {
      console.log("Already commented");
      return { statusCode: 200, body: "Already done" };
    }

    if (!isManualTag) {
      if (!await isOrderEmail(subject, bodyText, sender)) {
        console.log("Not an order");
        return { statusCode: 200, body: "Not an order" };
      }
      console.log("Order detected");
    }

    const validAttachment = (msg.attachments || []).find(a => ACCEPTED_ATTACHMENT_TYPES.includes(a.content_type));
    const timestamp = Date.now();
    const safeSubject = subject.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);

    let fileBuffer, fileName, contentType;
    if (validAttachment) {
      console.log(`Downloading: ${validAttachment.filename}`);
      fileBuffer = await downloadAttachment(validAttachment.url);
      fileName = `${timestamp}_${safeSubject}.${validAttachment.filename?.split(".").pop() || "pdf"}`;
      contentType = validAttachment.content_type;
    } else {
      console.log("Using email body");
      fileBuffer = buildEmailText(conversation, msg);
      fileName = `${timestamp}_${safeSubject}.txt`;
      contentType = "text/plain";
    }

    console.log(`Uploading: ${fileName}`);
    const fileUrl = await uploadToSupabase(fileBuffer, fileName, contentType);

    const comment = `📋 Order identified (${validAttachment ? "attachment" : "email body"}). Click to process:\n${ORDER_ENTRY_APP}/?po_file=${encodeURIComponent(fileUrl)}`;
    console.log(`Commenting on ${conversationId}`);
    await postComment(conversationId, comment);
    console.log("Done");

    return { statusCode: 200, body: "OK" };

  } catch (err) {
    console.error(`Error: ${err.message}`);
    return { statusCode: 200, body: "Error handled" };
  }
};

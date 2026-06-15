// PMI Tape — Front App Webhook Handler v6
// Two-phase: returns 200 to Front instantly, then processes via a self-call
// to a separate background endpoint so Netlify doesn't kill the process.

const https = require("https");
const crypto = require("crypto");

const FRONT_API_BASE = "https://api2.frontapp.com";
const SUPABASE_URL = "https://zhvfcipveeeybczzmues.supabase.co";
const SUPABASE_BUCKET = "purchase-orders";
const ORDER_ENTRY_APP = "https://pmiorder.netlify.app";
const CUSTOMER_ORDER_TAG = "Customer Order";
const ORDERS_INBOX_ADDRESS = "customerservice@pmitape.com";
const ACCEPTED_ATTACHMENT_TYPES = [
  "application/pdf","image/jpeg","image/jpg",
  "image/png","image/gif","image/webp","image/tiff",
];

const FRONT_API_TOKEN    = process.env.FRONT_API_TOKEN;
const FRONT_WEBHOOK_SECRET = process.env.FRONT_WEBHOOK_SECRET;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
// The URL of THIS Netlify site (set in env vars as SITE_URL, e.g. https://pmiorderemail.netlify.app)
const SITE_URL = process.env.SITE_URL || "https://pmiorderemail.netlify.app";

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(method, urlStr, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const bodyData = body !== null
      ? (Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body)))
      : null;
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: { ...headers, ...(bodyData ? { "Content-Length": bodyData.length } : {}) },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, raw, body: raw.toString("utf8") });
      });
    });
    req.on("error", reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

// ── Front API helpers ─────────────────────────────────────────────────────────
const frontHeaders = () => ({
  Authorization: `Bearer ${FRONT_API_TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json",
});

async function getConversation(id) {
  const r = await request("GET", `${FRONT_API_BASE}/conversations/${id}`, frontHeaders());
  if (r.status !== 200) throw new Error(`getConversation failed: ${r.status} ${r.body}`);
  return JSON.parse(r.body);
}

async function getMessages(id) {
  const r = await request("GET", `${FRONT_API_BASE}/conversations/${id}/messages`, frontHeaders());
  if (r.status !== 200) throw new Error(`getMessages failed: ${r.status} ${r.body}`);
  return JSON.parse(r.body);
}

async function downloadAttachment(url) {
  const r = await request("GET", url, { Authorization: `Bearer ${FRONT_API_TOKEN}` });
  if (r.status !== 200) throw new Error(`downloadAttachment failed: ${r.status}`);
  return r.raw;
}

async function postComment(conversationId, comment) {
  const r = await request(
    "POST", `${FRONT_API_BASE}/conversations/${conversationId}/comments`,
    frontHeaders(),
    JSON.stringify({ author_id: "tea_jloke", body: comment })
  );
  if (![200,201,204].includes(r.status)) throw new Error(`postComment failed: ${r.status} ${r.body}`);
}

async function alreadyCommented(conversationId) {
  const r = await request("GET", `${FRONT_API_BASE}/conversations/${conversationId}/comments`, frontHeaders());
  if (r.status !== 200) return false;
  const data = JSON.parse(r.body);
  return (data._results || data.results || []).some(c => c.body?.includes("Order identified"));
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
const sbHeaders = () => ({
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
});

async function uploadToSupabase(fileBuffer, fileName, contentType) {
  // Ensure bucket exists
  const check = await request("GET", `${SUPABASE_URL}/storage/v1/bucket/${SUPABASE_BUCKET}`, sbHeaders());
  if (check.status !== 200) {
    await request("POST", `${SUPABASE_URL}/storage/v1/bucket`,
      { ...sbHeaders(), "Content-Type": "application/json" },
      JSON.stringify({ id: SUPABASE_BUCKET, name: SUPABASE_BUCKET, public: true })
    );
  }
  const r = await request("POST", `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${fileName}`,
    { ...sbHeaders(), "Content-Type": contentType, "x-upsert": "true" },
    fileBuffer
  );
  if (![200,201].includes(r.status)) throw new Error(`uploadToSupabase failed: ${r.status} ${r.body}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${fileName}`;
}

// ── Email body → text file ────────────────────────────────────────────────────
function buildEmailTextFile(conversation, message) {
  const from = message.from ? `${message.from.name || ""} <${message.from.handle || ""}>`.trim() : "Unknown";
  const date = message.created_at
    ? new Date(message.created_at * 1000).toLocaleString("en-US", { timeZone: "America/Indiana/Indianapolis" })
    : "Unknown";
  return Buffer.from([
    `FROM:    ${from}`,
    `TO:      ${ORDERS_INBOX_ADDRESS}`,
    `DATE:    ${date}`,
    `SUBJECT: ${conversation.subject || ""}`,
    ``, `─────────────────────────────────────────────────`, ``,
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
      max_tokens: 150,
      messages: [{
        role: "user",
        content: `You help PMI Tape identify customer purchase orders at ${ORDERS_INBOX_ADDRESS}.

Is this email a customer placing a product order or submitting a purchase order?

YES if: contains PO number/line items/quantities, customer ordering/reordering products with quantities.
NO if: general inquiry, shipping status, complaint, marketing/spam, internal, invoice/payment notice, automated notification.

FROM: ${sender}
SUBJECT: ${subject}
BODY: ${body.slice(0, 2000)}

Reply ONLY with JSON: {"is_order": true, "reason": "brief"} or {"is_order": false, "reason": "brief"}`
      }],
    })
  );
  if (r.status !== 200) throw new Error(`Claude API failed: ${r.status}`);
  const text = JSON.parse(r.body).content?.[0]?.text || "{}";
  try {
    const result = JSON.parse(text.replace(/```json|```/g, "").trim());
    console.log(`Claude: ${JSON.stringify(result)}`);
    return result.is_order === true;
  } catch {
    return false;
  }
}

// ── Signature verification ────────────────────────────────────────────────────
function verifySignature(rawBody, sig) {
  if (!FRONT_WEBHOOK_SECRET) return true;
  if (!sig) return false;
  const expected = crypto.createHmac("sha1", FRONT_WEBHOOK_SECRET).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// ── Core processing logic ─────────────────────────────────────────────────────
async function processConversation(conversationId, isManualTag) {
  console.log(`Processing conversation: ${conversationId}, manual: ${isManualTag}`);

  const [conversation, messagesData] = await Promise.all([
    getConversation(conversationId),
    getMessages(conversationId),
  ]);

  const messages = messagesData._results || messagesData.results || [];
  if (!messages.length) { console.log("No messages"); return; }

  const msg = messages[messages.length - 1];
  const subject = conversation.subject || "";
  const bodyText = msg.text || msg.body || "";
  const sender = msg.from?.handle || "unknown";

  if (await alreadyCommented(conversationId)) {
    console.log("Already commented, skipping");
    return;
  }

  if (!isManualTag) {
    if (!await isOrderEmail(subject, bodyText, sender)) {
      console.log("Not an order, skipping");
      return;
    }
    console.log("Identified as order");
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
    console.log("No attachment, using email body");
    fileBuffer = buildEmailTextFile(conversation, msg);
    fileName = `${timestamp}_${safeSubject}.txt`;
    contentType = "text/plain";
  }

  console.log(`Uploading: ${fileName}`);
  const fileUrl = await uploadToSupabase(fileBuffer, fileName, contentType);

  const orderAppUrl = `${ORDER_ENTRY_APP}/?po_file=${encodeURIComponent(fileUrl)}`;
  const source = validAttachment ? "attachment" : "email body";
  const comment = `📋 Order identified (${source}). Click to process:\n${orderAppUrl}`;

  console.log(`Posting comment to ${conversationId}`);
  await postComment(conversationId, comment);
  console.log("Done");
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event, context) => {
  // Keep function alive for background work
  if (context && context.callbackWaitsForEmptyEventLoop !== undefined) {
    context.callbackWaitsForEmptyEventLoop = false;
  }

  // Health check
  if (event.httpMethod === "GET") {
    return { statusCode: 200, body: "PMI Tape Front Webhook v6 — OK" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "OK" };
  }

  // Front webhook verification challenge
  const challenge = event.headers["x-front-challenge"] || event.headers["X-Front-Challenge"];
  if (challenge) {
    console.log("Verification challenge received");
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge }),
    };
  }

  const rawBody = event.body || "";

  // Parse payload
  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return { statusCode: 200, body: "Invalid JSON" }; }

  const eventType = payload.type;
  const eventData = payload.payload || {};
  console.log(`Event: ${eventType}`);

  let conversationId = null;
  let isManualTag = false;

  if (eventType === "inbound_received" || eventType === "inbound") {
    conversationId = eventData.conversation?.id || eventData.id;
    console.log(`Inbound conversation: ${conversationId}`);
  }

  if (eventType === "tag_added" || eventType === "tag") {
    const tagName = eventData.target?.data?.name || eventData.tag?.name || "";
    const convId = typeof eventData.conversation === "string"
      ? eventData.conversation
      : (eventData.conversation?.id || "");
    console.log(`Tag: "${tagName}", conv: "${convId}"`);
    if (tagName === CUSTOMER_ORDER_TAG) {
      conversationId = convId;
      isManualTag = true;
    }
  }

  // ── Return 200 immediately, THEN process ─────────────────────────────────
  if (conversationId) {
    // Use setImmediate to ensure response is sent before processing starts
    setImmediate(() => {
      processConversation(conversationId, isManualTag).catch(err => {
        console.error("Processing error:", err.message);
      });
    });
  }

  return { statusCode: 200, body: "OK" };
};

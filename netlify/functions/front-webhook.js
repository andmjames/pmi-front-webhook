// PMI Tape — Front App Webhook Handler
// Handles two triggers:
//   1. Inbound email event  → Claude classifies → if order, store + comment
//   2. "Customer Order" tag → skip classification → store + comment

const https = require("https");
const crypto = require("crypto");

// ── Constants ────────────────────────────────────────────────────────────────
const FRONT_API_BASE = "https://api2.frontapp.com";
const SUPABASE_URL = "https://zhvfcipveeeybczzmues.supabase.co";
const SUPABASE_BUCKET = "purchase-orders";
const ORDER_ENTRY_APP = "https://pmiorder.netlify.app";
const CUSTOMER_ORDER_TAG = "Customer Order";
const ORDERS_INBOX_ADDRESS = "customerservice@pmitape.com";
const ACCEPTED_ATTACHMENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/tiff",
];

// ── Env vars (set in Netlify dashboard) ──────────────────────────────────────
const FRONT_API_TOKEN = process.env.FRONT_API_TOKEN;
const FRONT_WEBHOOK_SECRET = process.env.FRONT_WEBHOOK_SECRET; // optional but recommended
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(method, urlStr, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : require("http");

    const bodyData =
      body !== null
        ? Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === "string" ? body : JSON.stringify(body))
        : null;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        ...headers,
        ...(bodyData ? { "Content-Length": bodyData.length } : {}),
      },
    };

    const req = lib.request(options, (res) => {
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
function frontHeaders() {
  return {
    Authorization: `Bearer ${FRONT_API_TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function getConversation(conversationId) {
  const res = await request("GET", `${FRONT_API_BASE}/conversations/${conversationId}`, frontHeaders());
  if (res.status !== 200) throw new Error(`Front get conversation failed: ${res.status} ${res.body}`);
  return JSON.parse(res.body);
}

async function getMessages(conversationId) {
  const res = await request("GET", `${FRONT_API_BASE}/conversations/${conversationId}/messages`, frontHeaders());
  if (res.status !== 200) throw new Error(`Front get messages failed: ${res.status} ${res.body}`);
  return JSON.parse(res.body);
}

async function downloadAttachment(attachmentUrl) {
  // Front attachment URLs need auth
  const res = await request("GET", attachmentUrl, { Authorization: `Bearer ${FRONT_API_TOKEN}` });
  if (res.status !== 200) throw new Error(`Attachment download failed: ${res.status}`);
  return res.raw; // Buffer
}

async function postComment(conversationId, comment) {
  const body = JSON.stringify({ author_id: "alt:email:customerservice@pmitape.com", body: comment });
  const res = await request(
    "POST",
    `${FRONT_API_BASE}/conversations/${conversationId}/comments`,
    frontHeaders(),
    body
  );
  // 204 or 200 both indicate success for Front comments
  if (res.status !== 200 && res.status !== 204 && res.status !== 201) {
    throw new Error(`Front post comment failed: ${res.status} ${res.body}`);
  }
  return true;
}

async function conversationAlreadyCommented(conversationId) {
  // Check existing comments to avoid duplicates
  const res = await request(
    "GET",
    `${FRONT_API_BASE}/conversations/${conversationId}/comments`,
    frontHeaders()
  );
  if (res.status !== 200) return false;
  const data = JSON.parse(res.body);
  const comments = data._results || data.results || [];
  return comments.some(
    (c) => c.body && c.body.includes("Order identified")
  );
}

// ── Supabase Storage helpers ──────────────────────────────────────────────────
function supabaseHeaders() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  };
}

async function ensureBucketExists() {
  // Check if bucket exists
  const listRes = await request(
    "GET",
    `${SUPABASE_URL}/storage/v1/bucket/${SUPABASE_BUCKET}`,
    supabaseHeaders()
  );

  if (listRes.status === 200) return; // already exists

  // Create bucket (public so the link works without auth)
  const createRes = await request(
    "POST",
    `${SUPABASE_URL}/storage/v1/bucket`,
    { ...supabaseHeaders(), "Content-Type": "application/json" },
    JSON.stringify({ id: SUPABASE_BUCKET, name: SUPABASE_BUCKET, public: true })
  );

  if (createRes.status !== 200 && createRes.status !== 201) {
    throw new Error(`Bucket create failed: ${createRes.status} ${createRes.body}`);
  }
}

async function uploadToSupabase(fileBuffer, fileName, contentType) {
  await ensureBucketExists();

  const uploadRes = await request(
    "POST",
    `${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${fileName}`,
    {
      ...supabaseHeaders(),
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    fileBuffer
  );

  if (uploadRes.status !== 200 && uploadRes.status !== 201) {
    throw new Error(`Supabase upload failed: ${uploadRes.status} ${uploadRes.body}`);
  }

  // Return the public URL
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${fileName}`;
  return publicUrl;
}

// ── Email → text file helper ──────────────────────────────────────────────────
function buildEmailTextFile(conversation, message) {
  const from = message.from
    ? `${message.from.name || ""} <${message.from.handle || ""}>`.trim()
    : "Unknown Sender";
  const subject = conversation.subject || "(no subject)";
  const date = message.created_at
    ? new Date(message.created_at * 1000).toLocaleString("en-US", { timeZone: "America/Indiana/Indianapolis" })
    : "Unknown Date";
  const body = message.text || message.body || "(no body)";

  const text = [
    `FROM:    ${from}`,
    `TO:      ${ORDERS_INBOX_ADDRESS}`,
    `DATE:    ${date}`,
    `SUBJECT: ${subject}`,
    ``,
    `─────────────────────────────────────────────────`,
    ``,
    body,
  ].join("\n");

  return Buffer.from(text, "utf8");
}

// ── Claude classification ─────────────────────────────────────────────────────
async function isOrderEmail(subject, body, senderEmail) {
  const prompt = `You are helping PMI Tape (a tape manufacturer) identify customer purchase orders and product order requests received at ${ORDERS_INBOX_ADDRESS}.

Analyze this inbound email and determine if it is a customer placing a product order or submitting a purchase order.

Answer YES if the email:
- Contains a purchase order (PO number, line items with quantities, product codes/names)
- Is a customer requesting to order/reorder specific products with quantities
- Is a customer confirming or placing an order

Answer NO if the email is:
- A general inquiry or question
- A shipping status request
- A complaint or issue report
- Marketing or spam
- An internal message
- A reply that is not itself an order
- An invoice, payment, or remittance notice

Email details:
FROM: ${senderEmail}
SUBJECT: ${subject}
BODY:
${body.slice(0, 3000)}

Reply with ONLY a JSON object in this exact format:
{"is_order": true, "confidence": "high", "reason": "brief reason"}
or
{"is_order": false, "confidence": "high", "reason": "brief reason"}`;

  const res = await request(
    "POST",
    "https://api.anthropic.com/v1/messages",
    {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    })
  );

  if (res.status !== 200) throw new Error(`Claude API failed: ${res.status} ${res.body}`);

  const data = JSON.parse(res.body);
  const text = data.content?.[0]?.text || "{}";

  try {
    const clean = text.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);
    console.log(`Claude classification: ${JSON.stringify(result)}`);
    return result.is_order === true;
  } catch {
    console.warn("Could not parse Claude response, defaulting to false:", text);
    return false;
  }
}

// ── Webhook signature verification ───────────────────────────────────────────
function verifySignature(rawBody, signatureHeader) {
  if (!FRONT_WEBHOOK_SECRET) return true; // skip if secret not configured
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac("sha1", FRONT_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signatureHeader),
    Buffer.from(expected)
  );
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // Simple GET health check
  if (event.httpMethod === "GET") {
    return { statusCode: 200, body: "PMI Tape Front Webhook — OK" };
  }

  // Only accept POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // ── Front webhook verification ──────────────────────────────────────────────
  // Front sends a POST with header x-front-challenge during webhook setup.
  // Must respond with {"challenge": "<value>"} and content-type application/json.
  const frontChallenge =
    event.headers["x-front-challenge"] || event.headers["X-Front-Challenge"];
  if (frontChallenge) {
    console.log("Front webhook verification challenge received, echoing back");
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge: frontChallenge }),
    };
  }

  const rawBody = event.body || "";

  // Verify webhook signature if secret is set
  const signature = event.headers["x-front-signature"] || event.headers["X-Front-Signature"];
  if (!verifySignature(rawBody, signature)) {
    console.error("Invalid webhook signature");
    return { statusCode: 401, body: "Unauthorized" };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  const eventType = payload.type;
  console.log(`Received Front event: ${eventType}`);

  // ── Determine if we should process this event ──────────────────────────────
  let conversationId = null;
  let isManualTag = false;

  // Trigger 1: Inbound email
  if (eventType === "inbound") {
    conversationId = payload.conversation?.id;
  }

  // Trigger 2: Tag applied
  // Front sends event type "tag_added" (not "tag")
  if (eventType === "tag_added" || eventType === "tag") {
    // Log the full payload structure so we can see exactly where the tag name lives
    console.log(`Tag event payload: ${JSON.stringify({
      type: payload.type,
      tag: payload.tag,
      tags: payload.tags,
      conversation_id: payload.conversation?.id,
      target: payload.target,
    })}`);
    // Tag name can be in payload.tag.name or payload.tags[0].name depending on Front version
    const tagName = payload.tag?.name || payload.tags?.[0]?.name || "";
    console.log(`Tag name detected: "${tagName}" — looking for "${CUSTOMER_ORDER_TAG}"`);
    if (tagName === CUSTOMER_ORDER_TAG) {
      conversationId = payload.conversation?.id;
      isManualTag = true;
      console.log(`Manual "Customer Order" tag applied to ${conversationId}`);
    }
  }

  // Nothing to process
  if (!conversationId) {
    return { statusCode: 200, body: "Event ignored" };
  }

  try {
    // ── Fetch conversation and messages ──────────────────────────────────────
    const [conversation, messagesData] = await Promise.all([
      getConversation(conversationId),
      getMessages(conversationId),
    ]);

    const messages = messagesData._results || messagesData.results || [];
    if (messages.length === 0) {
      console.log("No messages found in conversation");
      return { statusCode: 200, body: "No messages" };
    }

    // Use the first (oldest) message as the order — that's the original customer email
    const originalMessage = messages[messages.length - 1];
    const subject = conversation.subject || "";
    const bodyText = originalMessage.text || originalMessage.body || "";
    const senderEmail = originalMessage.from?.handle || "unknown";

    // ── Deduplicate: skip if already commented ───────────────────────────────
    const alreadyDone = await conversationAlreadyCommented(conversationId);
    if (alreadyDone) {
      console.log("Already commented on this conversation, skipping");
      return { statusCode: 200, body: "Already processed" };
    }

    // ── Classify (skip if manual tag) ────────────────────────────────────────
    if (!isManualTag) {
      const isOrder = await isOrderEmail(subject, bodyText, senderEmail);
      if (!isOrder) {
        console.log("Not identified as an order, skipping");
        return { statusCode: 200, body: "Not an order" };
      }
      console.log("Claude identified as an order");
    }

    // ── Find attachment or use email body ─────────────────────────────────────
    const attachments = originalMessage.attachments || [];
    const validAttachment = attachments.find((a) =>
      ACCEPTED_ATTACHMENT_TYPES.includes(a.content_type)
    );

    let fileBuffer;
    let fileName;
    let contentType;
    const timestamp = Date.now();
    const safeSubject = subject.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);

    if (validAttachment) {
      console.log(`Downloading attachment: ${validAttachment.filename} (${validAttachment.content_type})`);
      fileBuffer = await downloadAttachment(validAttachment.url);
      const ext = validAttachment.filename?.split(".").pop() || "pdf";
      fileName = `${timestamp}_${safeSubject}.${ext}`;
      contentType = validAttachment.content_type;
    } else {
      console.log("No valid attachment found, capturing email body as text file");
      fileBuffer = buildEmailTextFile(conversation, originalMessage);
      fileName = `${timestamp}_${safeSubject}.txt`;
      contentType = "text/plain";
    }

    // ── Upload to Supabase Storage ────────────────────────────────────────────
    console.log(`Uploading to Supabase: ${fileName}`);
    const fileUrl = await uploadToSupabase(fileBuffer, fileName, contentType);

    // ── Build Order Entry app URL ─────────────────────────────────────────────
    const encodedUrl = encodeURIComponent(fileUrl);
    const orderAppUrl = `${ORDER_ENTRY_APP}/?po_file=${encodedUrl}`;

    // ── Post comment to Front ─────────────────────────────────────────────────
    const source = validAttachment ? "attachment" : "email body";
    const comment = `📋 Order identified (${source}). Click to process:\n${orderAppUrl}`;

    console.log(`Posting comment to conversation ${conversationId}`);
    await postComment(conversationId, comment);

    console.log("Done — comment posted successfully");
    return { statusCode: 200, body: "OK" };

  } catch (err) {
    console.error("Webhook handler error:", err.message);
    // Return 200 anyway so Front doesn't retry endlessly
    return { statusCode: 200, body: `Error handled: ${err.message}` };
  }
};

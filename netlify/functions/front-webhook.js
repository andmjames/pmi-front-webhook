// PMI Tape — Front App Webhook Handler v8
// Synchronous, completes within Front's 5-second timeout.
// Smart attachment selection: prefers PDFs, skips inline/signature images.

const https = require("https");
const crypto = require("crypto");

const FRONT_API_BASE       = "https://api2.frontapp.com";
const SUPABASE_URL         = "https://zhvfcipveeeybczzmues.supabase.co";
const SUPABASE_BUCKET      = "purchase-orders";
const ORDER_ENTRY_APP      = "https://pmiorder.netlify.app";
const CUSTOMER_ORDER_TAG   = "Customer Order";
const ORDERS_INBOX_ADDRESS = "customerservice@pmitape.com";

const FRONT_API_TOKEN      = process.env.FRONT_API_TOKEN;
const FRONT_WEBHOOK_SECRET = process.env.FRONT_WEBHOOK_SECRET;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY;

// ── Attachment selection ──────────────────────────────────────────────────────
// Filenames that are almost certainly email signatures, not POs
const SIGNATURE_FILENAME_PATTERNS = [
  /^image\d+\.(gif|png|jpg|jpeg)$/i,   // image001.gif, image002.png
  /^untitled\s*attachment/i,            // Untitled attachment, Untitled attachment.gif
  /signature/i,                         // signature.png, my-signature.gif
  /^logo\./i,                           // logo.png, logo.gif
  /^banner\./i,
  /^header\./i,
  /^footer\./i,
];

// Minimum size in bytes for an image to be considered a real document (not a signature)
// Signatures are typically tiny; a scanned PO page is usually >50KB
const MIN_DOCUMENT_IMAGE_BYTES = 50000;

function selectBestAttachment(attachments) {
  if (!attachments || attachments.length === 0) return null;

  // Filter out inline attachments (embedded in email body, e.g. signature images)
  const nonInline = attachments.filter(a => !a.metadata?.is_inline && !a.is_inline);

  // 1. Prefer PDF — almost all POs come as PDF
  const pdf = nonInline.find(a => a.content_type === "application/pdf");
  if (pdf) {
    console.log(`Selected PDF attachment: ${pdf.filename}`);
    return pdf;
  }

  // 2. Filter images — skip known signature filenames and tiny files
  const images = nonInline.filter(a => /^image\//.test(a.content_type));
  const poImages = images.filter(a => {
    const filename = a.filename || "";
    const isSignatureFilename = SIGNATURE_FILENAME_PATTERNS.some(p => p.test(filename));
    if (isSignatureFilename) {
      console.log(`Skipping likely signature: ${filename}`);
      return false;
    }
    // Skip tiny images (likely signatures/logos)
    const size = a.size || a.content_length || 0;
    if (size > 0 && size < MIN_DOCUMENT_IMAGE_BYTES) {
      console.log(`Skipping small image (${size} bytes): ${filename}`);
      return false;
    }
    return true;
  });

  if (poImages.length > 0) {
    // Pick the largest image — most likely to be the actual PO
    const largest = poImages.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
    console.log(`Selected image attachment: ${largest.filename} (${largest.size || "unknown"} bytes)`);
    return largest;
  }

  // 3. Log what we're skipping so we can tune if needed
  console.log(`No suitable attachment found. Available: ${attachments.map(a => `${a.filename}(${a.content_type},${a.size||"?"}b,inline:${a.is_inline||a.metadata?.is_inline||false})`).join(", ")}`);
  return null;
}

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
  const from = message.from
    ? `${message.from.name || ""} <${message.from.handle || ""}>`.trim()
    : "Unknown";
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
        `Is this email a customer purchase order or product order request to PMI Tape (a tape manufacturer)?\n\nFROM: ${sender}\nSUBJECT: ${subject}\nBODY: ${body.slice(0,1500)}\n\nReply ONLY with JSON: {"is_order":true} or {"is_order":false}`
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
  if (event.httpMethod === "GET") {
    return { statusCode: 200, body: "PMI Tape Front Webhook v8 — OK" };
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

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 200, body: "Bad JSON" }; }

  const eventType = payload.type;
  const eventData = payload.payload || {};
  console.log(`Event: ${eventType}`);

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

    // ── Smart attachment selection ─────────────────────────────────────────
    const validAttachment = selectBestAttachment(msg.attachments);

    const timestamp = Date.now();
    const safeSubject = subject.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);

    let fileBuffer, fileName, contentType;
    if (validAttachment) {
      fileBuffer = await downloadAttachment(validAttachment.url);
      const ext = validAttachment.filename?.split(".").pop() || "pdf";
      fileName = `${timestamp}_${safeSubject}.${ext}`;
      contentType = validAttachment.content_type;
    } else {
      console.log("No suitable attachment — using email body");
      fileBuffer = buildEmailText(conversation, msg);
      fileName = `${timestamp}_${safeSubject}.txt`;
      contentType = "text/plain";
    }

    console.log(`Uploading: ${fileName}`);
    const fileUrl = await uploadToSupabase(fileBuffer, fileName, contentType);

    const source = validAttachment ? "attachment" : "email body";
    const comment = `📋 Order identified (${source}). Click to process:\n${ORDER_ENTRY_APP}/?po_file=${encodeURIComponent(fileUrl)}`;

    console.log(`Commenting on ${conversationId}`);
    await postComment(conversationId, comment);
    console.log("Done");

    return { statusCode: 200, body: "OK" };

  } catch (err) {
    console.error(`Error: ${err.message}`);
    return { statusCode: 200, body: "Error handled" };
  }
};

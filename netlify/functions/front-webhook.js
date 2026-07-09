// PMI Tape — Front App Webhook Handler v11
// Synchronous, completes within Front's 5-second timeout.
// Smart attachment selection: prefers PDFs, skips inline/signature images.
// Claude reads the ACTUAL PDF/image contents to classify — not just the email body.

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

// Max attachment size to send to Claude for classification (keeps us under Front's 5s limit)
const MAX_CLASSIFY_BYTES = 4 * 1024 * 1024; // 4 MB

// ── Attachment selection ──────────────────────────────────────────────────────
const SIGNATURE_FILENAME_PATTERNS = [
  /^image\d+\.(gif|png|jpg|jpeg)$/i,
  /^untitled\s*attachment/i,
  /signature/i,
  /^logo\./i,
  /^banner\./i,
  /^header\./i,
  /^footer\./i,
];

const MIN_DOCUMENT_IMAGE_BYTES = 50000;

function selectBestAttachment(attachments) {
  if (!attachments || attachments.length === 0) return null;

  const nonInline = attachments.filter(a => !a.metadata?.is_inline && !a.is_inline);

  const pdf = nonInline.find(a => a.content_type === "application/pdf");
  if (pdf) {
    console.log(`Selected PDF attachment: ${pdf.filename}`);
    return pdf;
  }

  const images = nonInline.filter(a => /^image\//.test(a.content_type));
  const poImages = images.filter(a => {
    const filename = a.filename || "";
    if (SIGNATURE_FILENAME_PATTERNS.some(p => p.test(filename))) {
      console.log(`Skipping likely signature: ${filename}`);
      return false;
    }
    const size = a.size || a.content_length || 0;
    if (size > 0 && size < MIN_DOCUMENT_IMAGE_BYTES) {
      console.log(`Skipping small image (${size} bytes): ${filename}`);
      return false;
    }
    return true;
  });

  if (poImages.length > 0) {
    const largest = poImages.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
    console.log(`Selected image attachment: ${largest.filename} (${largest.size || "unknown"} bytes)`);
    return largest;
  }

  console.log(`No suitable attachment. Available: ${attachments.map(a => `${a.filename}(${a.content_type},${a.size||"?"}b,inline:${a.is_inline||a.metadata?.is_inline||false})`).join(", ")}`);
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

// ── Classification prompt ─────────────────────────────────────────────────────
const CLASSIFY_PROMPT = `You are triaging the inbox ${ORDERS_INBOX_ADDRESS} for PMI Tape, a manufacturer that SELLS adhesive tape to customers. Product brands: PMI, Tape Genie, FloorBond, DeckBond.

Your job: decide whether this email is a CUSTOMER PLACING AN ORDER WITH PMI TAPE.

An attached document (if any) is provided. Judge on the DOCUMENT CONTENTS above all — the email body is usually just "see attached."

=== START HERE: DIRECTION OF THE EMAIL ===
This email was RECEIVED at ${ORDERS_INBOX_ADDRESS}, PMI Tape's inbound customer
service inbox. PMI sends its own purchase orders OUT to its suppliers; those never
arrive here. Therefore:

  Attached document is a purchase order, received at this inbox
    -> a customer is ordering FROM PMI Tape
    -> is_order = TRUE

This holds even when PMI Tape is not named anywhere on the document.

=== DO NOT BE MISLED BY THESE (all are normal and expected) ===
1. The customer's name and logo appear at the top of the PO. It is THEIR document,
   printed on THEIR letterhead. This tells you who the BUYER is, not the seller.

2. PMI Tape may not be named as vendor at all. The "Vendor" field often holds only
   a vendor NUMBER (e.g. "Vendor #: 4021"). Absence of the words "PMI Tape" is NOT
   evidence that PMI is uninvolved.

3. "PMI" appears inside product names and SKUs — "PMI White Split Tape", "PMI
   Blackout Tape", "PMI3451", "PMID2". This is PMI's BRAND on the goods being
   purchased. It is not a statement about who is buying or selling. Seeing PMI in
   line items alongside a customer's letterhead is exactly what a customer PO to
   PMI Tape looks like.

4. The sender address may be an automated relay (e.g. system@sent-via.netsuite.com,
   noreply@ariba.com). Judge the document, not the envelope.

Worked example (a real case):
  Letterhead: Blue Ridge Screen Products, LLC. Column header: "Vendor #".
  Line items: "PMI White Split Tape 3x60", "PMI Blackout Tape 3x100YD". Total $7,465.44.
  Blue Ridge issued this PO on their letterhead. The goods are PMI-brand tape.
  It was emailed to PMI's customer service inbox.
  -> A customer is ordering PMI tape from PMI Tape.
  -> {"is_order": true, "doc_type": "purchase_order", ...}

=== TRUE ===
- A purchase order for tape products received at this inbox
- A customer writing out products and quantities they want to buy
- A release against a blanket PO, or a reorder request

=== FALSE ===
- An INVOICE, statement, remittance advice, or payment notice
- A purchase order that is clearly PMI Tape's OWN outbound PO to a supplier
  (PMI Tape on the letterhead as issuer, some other company as vendor)
- A QUOTE or RFQ (asking for pricing, not yet ordering)
- Order confirmations, shipping/tracking notices, delivery receipts, packing slips, BOLs
- Freight/carrier documents, customs paperwork, certificates of analysis, spec sheets
- Marketing, spam, solicitations, newsletters
- General questions, complaints, returns, credit requests
- Automated notifications (Dropbox, DocuSign, banking, software alerts)
- A reply in a thread that is not itself a new order

The FALSE purchase-order case is rare. Only choose it when PMI Tape is plainly the
issuer of the document. If a PO arrived here and lists tape products, it is TRUE.

Respond with ONLY this JSON, no other text:
{"is_order": true|false, "doc_type": "purchase_order|invoice|quote|confirmation|shipping|statement|marketing|inquiry|other", "issuer": "company whose letterhead is on the doc, or null", "products": "brief note on what goods are listed, or null", "reason": "one short sentence"}`;

// ── Claude classification — reads the attachment, not just the email body ──────
async function classifyEmail({ subject, body, sender, fileBuffer, contentType, fileName }) {
  const content = [];

  // Attach the document itself so Claude can read it
  if (fileBuffer && fileBuffer.length > 0 && fileBuffer.length <= MAX_CLASSIFY_BYTES) {
    const base64 = fileBuffer.toString("base64");
    if (contentType === "application/pdf") {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 },
      });
    } else if (/^image\//.test(contentType)) {
      const mediaType = contentType === "image/jpg" ? "image/jpeg" : contentType;
      content.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: base64 },
      });
    }
    console.log(`Sending ${contentType} (${fileBuffer.length} bytes) to Claude for classification`);
  } else if (fileBuffer && fileBuffer.length > MAX_CLASSIFY_BYTES) {
    console.log(`Attachment too large to classify (${fileBuffer.length} bytes) — classifying on email text only`);
  }

  content.push({
    type: "text",
    text: `${CLASSIFY_PROMPT}

--- EMAIL ---
FROM: ${sender}
SUBJECT: ${subject}
ATTACHMENT: ${fileName || "(none)"}
BODY:
${(body || "").slice(0, 2000)}`,
  });

  const r = await request(
    "POST", "https://api.anthropic.com/v1/messages",
    { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content }],
    })
  );

  if (r.status !== 200) {
    console.error(`Claude failed: ${r.status} ${r.body.slice(0, 300)}`);
    return { is_order: false, doc_type: "other", reason: "classification failed" };
  }

  try {
    const text = JSON.parse(r.body).content?.[0]?.text || "{}";
    const result = JSON.parse(text.replace(/```json|```/g, "").trim());
    console.log(`Claude: ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    console.error("Could not parse Claude response");
    return { is_order: false, doc_type: "other", reason: "unparseable response" };
  }
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
    return { statusCode: 200, body: "PMI Tape Front Webhook v11 — OK" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "OK" };
  }

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

    // ── Pick the attachment and download it ONCE ────────────────────────────
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

    // ── Classify (skip entirely if manually tagged) ─────────────────────────
    if (!isManualTag) {
      const verdict = await classifyEmail({
        subject,
        body: bodyText,
        sender,
        fileBuffer: validAttachment ? fileBuffer : null,
        contentType,
        fileName: validAttachment?.filename,
      });

      const roles = `issuer=${verdict.issuer || "?"} products=${verdict.products || "?"}`;
      if (verdict.is_order !== true) {
        console.log(`Not an order (${verdict.doc_type}) [${roles}]: ${verdict.reason}`);
        return { statusCode: 200, body: "Not an order" };
      }
      console.log(`Order confirmed [${roles}]: ${verdict.reason}`);
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

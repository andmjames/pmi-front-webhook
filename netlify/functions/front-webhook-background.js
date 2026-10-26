// PMI Tape — Front App Webhook BACKGROUND WORKER (v15)
// The "-background" suffix tells Netlify this may run up to 15 minutes, so there
// is no 5-second pressure. Invoked only by front-webhook.js, never by Front.
//
// ALL logic lives in _shared/pipeline.js — edit detection there, not here.

const { processConversation } = require("./_shared/pipeline");

exports.handler = async (event) => {
  let conversationId, isManualTag;
  try {
    const b = JSON.parse(event.body || "{}");
    conversationId = b.conversationId;
    isManualTag = b.isManualTag === true;
  } catch {
    console.error("Background: bad JSON body");
    return { statusCode: 200, body: "bad json" };
  }
  if (!conversationId) {
    console.error("Background: no conversationId");
    return { statusCode: 200, body: "no conversation" };
  }
  try {
    await processConversation(conversationId, isManualTag);
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error(`Background error: ${err.message}`);
    return { statusCode: 200, body: "error handled" };
  }
};

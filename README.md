# PMI Tape — Front Webhook Handler

Standalone Netlify function that monitors Front App for customer orders and posts
a link to the Order Entry app on identified conversations.

## Two trigger paths

| Trigger | How it works |
|---|---|
| **Automatic** | Every inbound email → Claude classifies → if order, proceed |
| **Manual** | User applies **"Customer Order"** tag in Front → skip classification, proceed |

## What it does when an order is identified

1. Checks for a PDF or image attachment on the original email
2. If attachment found → downloads it, stores in Supabase Storage
3. If no attachment → captures the email body as a `.txt` file, stores in Supabase Storage
4. Posts a Front comment: `📋 Order identified (attachment). Click to process: https://pmiorder.netlify.app/?po_file=...`
5. Deduplicates — will not post twice on the same conversation

## Netlify environment variables

Set these in the Netlify dashboard under **Site → Environment variables**:

| Variable | Value |
|---|---|
| `FRONT_API_TOKEN` | Your Front API token |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `FRONT_WEBHOOK_SECRET` | (Optional) Front webhook signing secret |

## Deploy steps

1. Deploy this repo as a new Netlify site
2. Set environment variables above
3. Note your function URL: `https://YOUR-SITE.netlify.app/.netlify/functions/front-webhook`

## Front App setup

### Webhook for inbound emails
1. Front Settings → Developers → Webhooks → Create webhook
2. URL: `https://YOUR-SITE.netlify.app/.netlify/functions/front-webhook`
3. Events: check **Inbound message**
4. Optionally copy the signing secret → set as `FRONT_WEBHOOK_SECRET` in Netlify

### Webhook for "Customer Order" tag
1. Front Settings → Developers → Webhooks → Create webhook (or add to same webhook)
2. URL: same as above
3. Events: check **Conversation tagged**

### Create the tag
1. Front Settings → Tags → New tag → Name: `Customer Order`
2. Share with all teammates who handle orders

## Supabase Storage

The function auto-creates a public bucket called `purchase-orders` on first run.
Files are stored as: `{timestamp}_{subject_snippet}.pdf` (or `.jpg`, `.txt`, etc.)

---
name: ef-webhooks
description: "Configure Editframe webhooks for render completion and file processing notifications. Use when the operator asks to set up webhooks for Editframe events."
invocation: user
category: fo
concerns: read-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
triggers:
  - "set up editframe webhooks"
  - "render completion notification"
  - "file processing webhook"
  - "webhook signature verification"
source: https://editframe.com/skills/webhooks.md
---

<!-- skill-lint-disable SKILL-17 -->

# Webhooks

Use webhooks to receive real-time HTTP POST notifications when a render completes or a file finishes processing. Use them instead of polling `getRenderProgress`/`getFileProcessingProgress`.

No SDK function registers a webhook. Configure one on an API key, through the dashboard (Settings → API Keys, or `editframe.com/resource/api_keys`). Set a **Webhook URL** (must use HTTPS). Select which **Webhook Events** (topics) to receive. When you create or update the key, the dashboard generates a **Webhook Secret**, used to sign deliveries. Copy this secret and store it alongside the API key.

## Handling a webhook

```typescript
import express from "express";
import crypto from "node:crypto";

const app = express();

app.post("/webhooks/editframe", express.raw({ type: "*/*" }), (req, res) => {
  const signature = req.headers["x-webhook-signature"] as string;
  const rawBody = req.body as Buffer;

  const expected = crypto
    .createHmac("sha256", process.env.EDITFRAME_WEBHOOK_SECRET!)
    .update(rawBody)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))) {
    return res.status(401).send("Invalid signature");
  }

  res.status(200).send("OK");
  const payload = JSON.parse(rawBody.toString("utf-8"));
  processWebhookEvent(payload).catch(console.error);
});
```

Every request carries an `X-Webhook-Signature` header: `HMAC-SHA256(webhook_secret, raw_json_body)`, hex-encoded. Verify with `crypto.timingSafeEqual`, not `===`.

Use `express.raw()`, not `express.json()`. Signature verification needs the exact raw bytes. Re-serializing parsed JSON can reorder keys or change whitespace, which changes the hash and breaks verification.

## Payload

```typescript
{ topic: string, data: {...} }
```

### Render topics

`render.created`, `render.pending`, `render.rendering`, `render.completed`, `render.failed`

`data` includes `id`, `status`, `created_at`, `completed_at`, `failed_at`, `width`, `height`, `fps`, `byte_size`, `duration_ms`, `md5`, `metadata`, `expires_at` (`null` = permanent), `download_url` (populated once complete), `error` (populated on failure).

### File topics

`file.created`, `file.uploading`, `file.processing`, `file.ready`, `file.failed`, `file.updated`

`data` includes `id`, `type` (`video`/`image`/`caption`), `status`, `filename`, `byte_size`, `md5`, `mime_type`, `width`, `height`, `expires_at`.

### Legacy topics

`image_file.created`, `isobmff_file.created`, `isobmff_track.created`, `unprocessed_file.created`. Do not build new integrations against these.

## Delivery

- Each event arrives as one HTTP POST with a JSON body.
- Editframe retries on a fixed 10-second interval, up to 3 attempts total, with a 30-second timeout per attempt.
- Editframe may deliver an event more than once. Key side effects off `data.id` to stay idempotent.
- Always hash the **raw** request body for signature verification.

## Testing

```bash
npx editframe webhook -t render.completed
```

This sends a real test event to the URL configured on your API key. There is no `--webhookURL` flag — the target URL always comes from the key's dashboard configuration.

For local development, tunnel your dev server (e.g. `ngrok http 3000`) and point the API key's Webhook URL at the tunnel URL.

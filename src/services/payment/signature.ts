import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env";

// Chapa v2 webhooks: HMAC-SHA256(key = CHAPA_WEBHOOK_SECRET, message = raw
// request body bytes), sent as a lowercase hex digest in the
// "x-chapa-signature" header. Must run against the exact raw body — never a
// re-serialized/parsed version of it.
export function verifyChapaWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;

  const expected = createHmac("sha256", env.CHAPA_WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

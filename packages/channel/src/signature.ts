import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies Meta's X-Hub-Signature-256 header ("sha256=<hex>") over the exact raw request body.
 * Must run on the raw bytes: re-serialised JSON will not match.
 */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret || !header || !header.startsWith("sha256=")) return false;
  const received = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function signMetaPayload(rawBody: Buffer | string, appSecret: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
}

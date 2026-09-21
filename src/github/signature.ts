import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

export function verifyGithubSignature(input: {
  secret: string;
  rawBody: string;
  signatureHeader: string | undefined;
}): boolean {
  if (input.signatureHeader === undefined) {
    return false;
  }
  if (!input.signatureHeader.startsWith(PREFIX)) {
    return false;
  }
  const expected = createHmac("sha256", input.secret)
    .update(input.rawBody)
    .digest("hex");
  const given = input.signatureHeader.slice(PREFIX.length);
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(given, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

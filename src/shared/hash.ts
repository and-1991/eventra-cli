import crypto from "crypto";

export function hash(content: string) {
  return crypto.createHash("md5").update(content).digest("hex");
}

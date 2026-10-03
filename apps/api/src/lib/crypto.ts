import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function key(encryptionKey: string): Buffer {
  const buf = Buffer.from(encryptionKey, "base64");
  if (buf.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes");
  return buf;
}

/** AES-256-GCM with a random 12-byte IV. Output: base64(iv | authTag | ciphertext). */
export function encryptSecret(plaintext: string, encryptionKey: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key(encryptionKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptSecret(encoded: string, encryptionKey: string): string {
  const raw = Buffer.from(encoded, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key(encryptionKey), raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}

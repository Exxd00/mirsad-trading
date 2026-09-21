import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey(): Buffer {
  const value = process.env.ENCRYPTION_KEY;
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error("ENCRYPTION_KEY must be a base64-encoded random 32-byte key");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("Invalid encryption key");
  return key;
}

/** Bind ciphertext to a named broker/account so records cannot be silently swapped. */
export function encryptSecret(plaintext: string, context: string): string {
  if (!context || context.length > 500) throw new Error("Secret context is required");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(envelope: string, context: string): string {
  if (!context || context.length > 500) throw new Error("Secret context is required");
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || parts.slice(1).some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) throw new Error("Invalid encrypted secret");
  const [, ivEncoded, tagEncoded, ciphertext] = parts;
  const iv = Buffer.from(ivEncoded, "base64url");
  const tag = Buffer.from(tagEncoded, "base64url");
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  try { return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8"); }
  catch { throw new Error("Secret authentication failed"); }
}

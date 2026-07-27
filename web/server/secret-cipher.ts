import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedSecretPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

function decodeMasterKey(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("MCP master key must be a base64-encoded 32-byte key.");
  return key;
}

export function encryptSecret(
  plaintext: string,
  masterKey: string,
  keyVersion: number,
  aad: string,
): EncryptedSecretPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeMasterKey(masterKey), iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyVersion,
  };
}

export function decryptSecret(
  payload: EncryptedSecretPayload,
  masterKey: string,
  aad: string,
): string {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    decodeMasterKey(masterKey),
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

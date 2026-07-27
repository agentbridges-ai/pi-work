import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./secret-cipher.js";

describe("MCP secret envelope", () => {
  it("authenticates ciphertext against tenant and secret identity", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptSecret("top-secret", key, 3, "tenant-1:secret-1");
    expect(encrypted.ciphertext).not.toContain("top-secret");
    expect(decryptSecret(encrypted, key, "tenant-1:secret-1")).toBe("top-secret");
    expect(() => decryptSecret(encrypted, key, "tenant-2:secret-1")).toThrow();
  });
});

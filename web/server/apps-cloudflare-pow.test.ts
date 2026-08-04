import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CloudflarePreviewChallengeError,
  solveCloudflarePreviewChallenge,
  solveCloudflarePreviewChallengeSync,
  validateCloudflarePreviewChallenge,
} from "./apps-cloudflare-pow.js";

function challenge(overrides: Partial<{ k: number; g: number; seed: string }> = {}) {
  return {
    challengeToken: "challenge-token",
    seed: overrides.seed ?? randomBytes(32).toString("base64url"),
    k: overrides.k ?? 2,
    g: overrides.g ?? 3,
  };
}

describe("Cloudflare temporary preview proof of work", () => {
  it("validates the official challenge bounds", () => {
    const value = validateCloudflarePreviewChallenge(challenge({ k: 2, g: 3 }));
    expect(value.seed.byteLength).toBe(32);
    expect(value.k * value.g).toBe(6);
    expect(() => validateCloudflarePreviewChallenge(challenge({ k: 0 }))).toThrow(
      CloudflarePreviewChallengeError,
    );
    expect(() => validateCloudflarePreviewChallenge(challenge({ g: 0 }))).toThrow(
      CloudflarePreviewChallengeError,
    );
    expect(() => validateCloudflarePreviewChallenge(challenge({ k: 8_000, g: 8_001 }))).toThrow(
      /64,000,000/,
    );
    expect(() => validateCloudflarePreviewChallenge(challenge({ seed: "not-base64" }))).toThrow(
      /seed/,
    );
  });

  it("produces k+1 32-byte checkpoints encoded as standard base64", () => {
    const result = solveCloudflarePreviewChallengeSync(challenge({ k: 2, g: 3 }));
    const checkpoints = Buffer.from(result.solution.checkpoints, "base64");
    expect(result.challengeToken).toBe("challenge-token");
    expect(checkpoints.byteLength).toBe(3 * 32);
  });

  it("solves in a worker thread and matches the deterministic vector", async () => {
    const input = challenge({ k: 3, g: 2 });
    const [sync, threaded] = await Promise.all([
      Promise.resolve(solveCloudflarePreviewChallengeSync(input)),
      solveCloudflarePreviewChallenge(input, { timeoutMs: 10_000 }),
    ]);
    expect(threaded).toEqual(sync);
  });

  it("supports cancellation without an implicit retry", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      solveCloudflarePreviewChallenge(challenge(), { signal: controller.signal }),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("rejects malformed tokens, seeds, and worker timeout options", async () => {
    expect(() => validateCloudflarePreviewChallenge({ ...challenge(), challengeToken: "" })).toThrow(
      /challengeToken/,
    );
    expect(() => validateCloudflarePreviewChallenge({ ...challenge(), seed: "a" })).toThrow(
      /base64url/,
    );
    expect(() => validateCloudflarePreviewChallenge({ ...challenge(), seed: "a".repeat(42) })).toThrow(
      /32 bytes/,
    );
    await expect(
      solveCloudflarePreviewChallenge(challenge(), { timeoutMs: 0 }),
    ).rejects.toThrow(/timeoutMs/);
    await expect(
      solveCloudflarePreviewChallenge(challenge({ k: 10_000, g: 1 }), { timeoutMs: 1 }),
    ).rejects.toThrow(/timed out/);
  });
});

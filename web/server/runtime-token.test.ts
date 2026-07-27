import { describe, expect, it } from "vitest";
import { issueRuntimeToken, verifyRuntimeToken } from "./runtime-token.js";

const secret = "x".repeat(32);
const input = {
  tenantId: "t1",
  userId: "u1",
  sessionId: "s1",
  agentVersionId: "v1",
  action: "launch" as const,
};

describe("runtime task tokens", () => {
  it("binds a short-lived token to action, tenant and session", () => {
    const token = issueRuntimeToken(input, secret, { now: 100, ttlSeconds: 30 });
    expect(
      verifyRuntimeToken(token, secret, { action: "launch", tenantId: "t1", sessionId: "s1" }, 110),
    ).toMatchObject(input);
    expect(() => verifyRuntimeToken(token, secret, { action: "stop" }, 110)).toThrow(
      "action mismatch",
    );
    expect(() =>
      verifyRuntimeToken(token, secret, { action: "launch", tenantId: "t2" }, 110),
    ).toThrow("tenant mismatch");
  });

  it("rejects expired and tampered tokens", () => {
    const token = issueRuntimeToken(input, secret, { now: 100, ttlSeconds: 10 });
    expect(() => verifyRuntimeToken(token, secret, { action: "launch" }, 110)).toThrow("expired");
    expect(() => verifyRuntimeToken(`${token}x`, secret, { action: "launch" }, 105)).toThrow(
      "signature",
    );
  });
});

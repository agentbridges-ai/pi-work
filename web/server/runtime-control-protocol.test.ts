import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertRuntimeScope,
  encodeRuntimeControlFrame,
  makeRuntimeRequest,
  RuntimeControlAuthenticator,
  RuntimeControlDecoder,
} from "./runtime-control-protocol.js";

const scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  membershipId: "membership-a",
  orgNodeId: "org-root",
  sessionId: "session-a",
  generation: 3,
};

describe("Piwork Runtime control protocol", () => {
  it("authenticates canonical LF-framed requests across fragmentation", () => {
    const authenticator = new RuntimeControlAuthenticator(randomBytes(32));
    const encoded = encodeRuntimeControlFrame(
      makeRuntimeRequest("status", scope, { includeExited: false }, "request-1"),
      authenticator,
    );
    const decoder = new RuntimeControlDecoder();
    const first = decoder.push(encoded.subarray(0, 7), authenticator);
    const second = decoder.push(encoded.subarray(7), authenticator);
    expect(first).toEqual([]);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      kind: "request",
      id: "request-1",
      operation: "status",
      scope,
    });
  });

  it("rejects a tampered frame and unsafe scope", () => {
    const authenticator = new RuntimeControlAuthenticator(randomBytes(32));
    const encoded = encodeRuntimeControlFrame(makeRuntimeRequest("status", scope), authenticator);
    const tamperedFrame = JSON.parse(encoded.toString("utf8")) as { mac: string };
    tamperedFrame.mac = `${tamperedFrame.mac.slice(0, -1)}x`;
    const tampered = Buffer.from(`${JSON.stringify(tamperedFrame)}\n`, "utf8");
    expect(() => new RuntimeControlDecoder().push(tampered, authenticator)).toThrow(
      "authentication failed",
    );
    expect(() => assertRuntimeScope({ ...scope, sessionId: "../escape" })).toThrow();
  });

  it("requires a 256-bit control secret", () => {
    expect(() => new RuntimeControlAuthenticator(randomBytes(31))).toThrow("at least 32 bytes");
  });
});

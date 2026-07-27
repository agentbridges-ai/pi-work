import { describe, expect, it } from "vitest";
import { sanitizePublicSessionCreateRequest } from "./public-session-create.js";

describe("sanitizePublicSessionCreateRequest", () => {
  it("keeps the complete Pi browser session contract", () => {
    const model = {
      key: "openai/gpt-5",
      provider: "openai",
      modelId: "gpt-5",
    };
    const userSpace = {
      mountId: "mount-1",
      name: "Documents",
      rootName: "documents",
      status: "expected" as const,
      access: "readwrite" as const,
      includeHidden: true as const,
    };

    expect(
      sanitizePublicSessionCreateRequest({
        backend: "pi",
        agentId: "agent-1",
        model,
        thinkingLevel: "high",
        mode: "agent",
        resumeSessionAt: "turn-1",
        userSpace,
      }),
    ).toEqual({
      backend: "pi",
      agentId: "agent-1",
      model,
      thinkingLevel: "high",
      mode: "agent",
      resumeSessionAt: "turn-1",
      userSpace,
    });
  });

  it("drops every server-owned launch override from browser input", () => {
    const request = sanitizePublicSessionCreateRequest({
      backend: "pi",
      agentId: "agent-1",
      env: {
        NODE_OPTIONS: "--require=/tmp/inject.js",
        BASH_ENV: "/tmp/inject.sh",
      },
      piBinary: "/tmp/fake-pi",
      resolvedSandbox: { modelAllowlist: ["*"] },
      authority: { agentVersionId: "forged" },
      launchOrigin: "relaunch",
      sessionBinPath: "/tmp/bin",
    });

    expect(request).toEqual({ backend: "pi", agentId: "agent-1" });
    expect(request).not.toHaveProperty("env");
    expect(request).not.toHaveProperty("piBinary");
    expect(request).not.toHaveProperty("resolvedSandbox");
    expect(request).not.toHaveProperty("authority");
  });

  it.each([null, undefined, [], "pi", 42])("rejects non-object payload %j", (value) => {
    expect(sanitizePublicSessionCreateRequest(value)).toEqual({});
  });
});

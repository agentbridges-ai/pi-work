import { describe, expect, it, vi } from "vitest";
import {
  buildOnlyOfficeRequestInit,
  OnlyOfficeCliAbortError,
  requestWithRetries,
} from "../bin/onlyoffice.js";

const payload = {
  request_id: "stable-request",
  operation: { type: "get_document_text" },
};

describe("onlyoffice CLI retries", () => {
  it("routes requests through the configured Unix socket", () => {
    expect(
      buildOnlyOfficeRequestInit(
        { method: "POST", headers: { "Content-Type": "application/json" } },
        {
          PIWORK_USER_SPACE_API_TOKEN: "runtime-token",
          PIWORK_USER_SPACE_API_UNIX: "/tmp/piwork-user-space.sock",
        },
      ),
    ).toEqual({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer runtime-token",
      },
      unix: "/tmp/piwork-user-space.sock",
    });
  });

  it("rejects a relative Unix socket path", () => {
    expect(() =>
      buildOnlyOfficeRequestInit(
        {},
        {
          PIWORK_USER_SPACE_API_TOKEN: "runtime-token",
          PIWORK_USER_SPACE_API_UNIX: "relative.sock",
        },
      ),
    ).toThrow("must be an absolute Unix socket path");
  });

  it("retries transport failures three times with one idempotency key", async () => {
    const requestJson = vi
      .fn()
      .mockRejectedValueOnce(new Error("proxy disconnected"))
      .mockRejectedValueOnce(new Error("socket unavailable"))
      .mockResolvedValue({
        status: 200,
        statusText: "OK",
        text: "",
        body: { ok: true, result: { text: "ready" } },
      });

    await expect(
      requestWithRetries(payload, {
        requestJson,
        sleep: async () => undefined,
        apiBase: () => "http://onlyoffice.test/internal",
      }),
    ).resolves.toEqual({
      ok: true,
      result: { text: "ready" },
      attempts: 3,
      request_id: "stable-request",
    });
    expect(requestJson).toHaveBeenCalledTimes(3);
    for (const call of requestJson.mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).toEqual(payload);
    }
  });

  it("reports the current state after three retryable failures", async () => {
    const requestJson = vi.fn(async () => ({
      status: 503,
      statusText: "Service Unavailable",
      text: "",
      body: {
        ok: false,
        retryable: true,
        error: "ONLYOFFICE operation timed out.",
        document: { path: "Plan.docx", pluginReady: true },
      },
    }));

    const failure = await requestWithRetries(payload, {
      requestJson,
      sleep: async () => undefined,
      apiBase: () => "http://onlyoffice.test/internal",
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(OnlyOfficeCliAbortError);
    if (!(failure instanceof OnlyOfficeCliAbortError)) throw failure;
    expect(failure.report).toEqual({
      ok: false,
      attempts: 3,
      request_id: "stable-request",
      abortReason: "ONLYOFFICE operation timed out.",
      currentState: { path: "Plan.docx", pluginReady: true },
    });
    expect(requestJson).toHaveBeenCalledTimes(3);
  });

  it("queries the current state after three transport failures without replaying the operation", async () => {
    let operationAttempts = 0;
    const requestJson = vi.fn(async (url: string) => {
      if (url.endsWith("/active")) {
        return {
          status: 200,
          statusText: "OK",
          text: "",
          body: { document: { path: "Recovered.pptx", pluginReady: true } },
        };
      }
      operationAttempts += 1;
      throw new Error("proxy disconnected");
    });

    const failure = await requestWithRetries(payload, {
      requestJson,
      sleep: async () => undefined,
      apiBase: () => "http://onlyoffice.test/internal",
    }).catch((error) => error);

    if (!(failure instanceof OnlyOfficeCliAbortError)) throw failure;
    expect(failure.report).toEqual({
      ok: false,
      attempts: 3,
      request_id: "stable-request",
      abortReason: "proxy disconnected",
      currentState: { path: "Recovered.pptx", pluginReady: true },
    });
    expect(operationAttempts).toBe(3);
    expect(requestJson).toHaveBeenCalledTimes(4);
  });

  it("does not retry a non-retryable validation failure", async () => {
    const requestJson = vi.fn(async () => ({
      status: 400,
      statusText: "Bad Request",
      text: "",
      body: { ok: false, retryable: false, error: "Unsupported ONLYOFFICE operation." },
    }));

    const failure = await requestWithRetries(payload, {
      requestJson,
      sleep: async () => undefined,
      apiBase: () => "http://onlyoffice.test/internal",
    }).catch((error) => error);

    if (!(failure instanceof OnlyOfficeCliAbortError)) throw failure;
    expect(failure.report.attempts).toBe(1);
    expect(requestJson).toHaveBeenCalledTimes(1);
  });
});

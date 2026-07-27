// @vitest-environment jsdom

import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfficeEditorInstance } from "@agentbridges-ai/onlyoffice-browser";
import { requestWithRetries } from "../bin/onlyoffice.js";
import {
  attachOnlyOfficeTransport,
  handleOnlyOfficeBrowserRequest,
  registerOnlyOfficeEditor,
} from "../src/onlyoffice-browser-executor.js";
import { OnlyOfficeBroker, registerOnlyOfficeInternalRoutes } from "./onlyoffice-broker.js";
import type { SocketData } from "./ws-bridge-types.js";
import type { UserSpaceBroker } from "./user-space-broker.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function editor(): OfficeEditorInstance {
  return {
    id: "integration-editor",
    invokePlugin: vi.fn(async () => ({ text: "browser result" })),
    save: vi.fn(async () => new File(["saved"], "Plan.docx")),
    confirmSaveToNewFormat: vi.fn(async () => true),
    setInterfaceTheme: vi.fn(),
    setReadonly: vi.fn(),
    destroy: vi.fn(async () => undefined),
    getState: () => ({
      id: "integration-editor",
      fileName: "Plan.docx",
      fileType: "docx",
      mode: "edit",
      readonly: false,
      dirty: false,
      sourceKind: "local-file",
      status: "ready",
      destroyed: false,
    }),
    getHostIdentity: () => ({
      packageVersion: "0.3.30",
      hostBuildId: "office-host-0.3.30-r2",
      assetManifestDigest: "a".repeat(64),
    }),
  };
}

describe("ONLYOFFICE Skill to browser bridge", () => {
  it("carries one idempotent CLI request through the server to its assigned browser", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const socket = { id: "assigned-browser" } as unknown as ServerWebSocket<SocketData>;
    const instance = editor();
    const broker = new OnlyOfficeBroker();
    cleanups.push(() => broker.dispose());

    const detachTransport = attachOnlyOfficeTransport(sessionId, (status) =>
      broker.updateStatus(sessionId, status, socket),
    );
    cleanups.push(detachTransport);
    const registration = registerOnlyOfficeEditor({
      sessionId,
      instance,
      title: "Plan.docx",
      mountId: "mount-1",
      path: "Plan.docx",
      fileType: "docx",
      documentType: "word",
      writable: true,
      foreground: true,
    });
    cleanups.push(() => registration.dispose());

    broker.setSender((recipient, message) => {
      expect(recipient).toBe(socket);
      if (message.type !== "onlyoffice_request") throw new Error("Expected Office request");
      void handleOnlyOfficeBrowserRequest(sessionId, message, (response) => {
        broker.resolveResponse(
          sessionId,
          response.request_id,
          recipient,
          response.ok,
          response.result,
          response.error,
        );
      });
    });

    const app = new Hono();
    registerOnlyOfficeInternalRoutes(app, broker, {
      validateInternalCapability: () => true,
    } as unknown as UserSpaceBroker);
    const requestJson = async (url: string, init: RequestInit = {}) => {
      const response = await app.request(url, init);
      const text = await response.text();
      return {
        status: response.status,
        statusText: response.statusText,
        text,
        body: JSON.parse(text) as Record<string, unknown>,
      };
    };
    const payload = {
      request_id: "integration-request",
      operation: { type: "get_document_text" },
    };

    await expect(
      requestWithRetries(payload, {
        requestJson,
        sleep: async () => undefined,
        apiBase: () => `http://piwork.test/internal/onlyoffice/${sessionId}`,
      }),
    ).resolves.toEqual({
      ok: true,
      result: { text: "browser result" },
      attempts: 1,
      request_id: "integration-request",
    });
    await expect(
      requestWithRetries(payload, {
        requestJson,
        sleep: async () => undefined,
        apiBase: () => `http://piwork.test/internal/onlyoffice/${sessionId}`,
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(instance.invokePlugin).toHaveBeenCalledTimes(1);
  });
});

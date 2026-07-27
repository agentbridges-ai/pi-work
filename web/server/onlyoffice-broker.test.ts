import type { ServerWebSocket } from "bun";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { OnlyOfficeBroker, registerOnlyOfficeInternalRoutes } from "./onlyoffice-broker.js";
import type { UserSpaceBroker } from "./user-space-broker.js";
import type { SocketData } from "./ws-bridge-types.js";
import { parseOnlyOfficeOperation } from "../shared/onlyoffice.js";

function socket(id: string): ServerWebSocket<SocketData> {
  return { id } as unknown as ServerWebSocket<SocketData>;
}

function activeDocument(writable = true) {
  return {
    leaseId: "lease-1",
    editorInstanceId: "editor-1",
    title: "Plan.docx",
    mountId: "mount-1",
    path: "Plan.docx",
    fileType: "docx",
    documentType: "word" as const,
    writable,
    pluginReady: true,
    foreground: true,
  };
}

describe("ONLYOFFICE operation validation", () => {
  it("requires tracked changes for Word mutations", () => {
    expect(() =>
      parseOnlyOfficeOperation({
        type: "replace_all_text",
        searchText: "old",
        replaceText: "new",
      }),
    ).toThrow("trackChanges=true");
  });

  it("accepts Excel cell and chart operations", () => {
    expect(
      parseOnlyOfficeOperation({ type: "set_range_values", range: "A1:B2", values: [[1, 2]] }),
    ).toEqual(expect.objectContaining({ type: "set_range_values" }));
    expect(() =>
      parseOnlyOfficeOperation({
        type: "set_range_values",
        range: "A1:B2",
        values: [["Used", null]],
      }),
    ).toThrow('null is unsupported (use "" for an empty cell)');
    expect(
      parseOnlyOfficeOperation({
        type: "insert_chart",
        dataRange: "A1:B5",
        chartType: "lineNormal",
        anchorCell: "D2",
        styleIndex: 2,
        widthMm: 120,
        heightMm: 80,
      }),
    ).toEqual(expect.objectContaining({ type: "insert_chart", anchorCell: "D2" }));
    expect(parseOnlyOfficeOperation({ type: "get_charts_info", sheet: "Sheet1" })).toEqual(
      expect.objectContaining({ type: "get_charts_info" }),
    );
    expect(() =>
      parseOnlyOfficeOperation({
        type: "insert_chart",
        dataRange: "A1:B5",
        chartType: "pie",
        anchorCell: "XFE1",
      }),
    ).toThrow("invalid title, layout, size, style, or anchor");
    expect(() =>
      parseOnlyOfficeOperation({
        type: "insert_chart",
        dataRange: "A1:B5",
        chartType: "pie",
        fromRow: -1,
      }),
    ).toThrow("invalid title, layout, size, style, or anchor");
  });

  it("accepts bounded PowerPoint read and append operations", () => {
    expect(
      parseOnlyOfficeOperation({ type: "get_slide_text", slideIndex: 0, maxChars: 2_000 }),
    ).toEqual(expect.objectContaining({ type: "get_slide_text" }));
    expect(
      parseOnlyOfficeOperation({ type: "append_slide", title: "Summary", body: "Next steps" }),
    ).toEqual(expect.objectContaining({ type: "append_slide" }));
    expect(() => parseOnlyOfficeOperation({ type: "get_slide_text", slideIndex: -1 })).toThrow(
      "zero-based slideIndex",
    );
  });
});

describe("OnlyOfficeBroker", () => {
  it("rejects explicit target routing from the Agent endpoint", async () => {
    const broker = new OnlyOfficeBroker();
    const browser = socket("browser");
    broker.updateStatus(
      "session-1",
      { type: "onlyoffice_status", document: activeDocument() },
      browser,
    );
    let sent = false;
    broker.setSender((recipient, message) => {
      sent = true;
      if (message.type === "onlyoffice_request") {
        broker.resolveResponse("session-1", message.request_id, recipient, true, { ok: true });
      }
    });
    const app = new Hono();
    registerOnlyOfficeInternalRoutes(app, broker, {
      validateInternalCapability: () => true,
    } as unknown as UserSpaceBroker);

    const response = await app.request("http://localhost/internal/onlyoffice/session-1/operation", {
      method: "POST",
      headers: {
        Authorization: "Bearer runtime-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request_id: "request-1",
        operation: { type: "append_text", text: "do not write this", trackChanges: true },
        target: { mountId: "mount-2", path: 42 },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "ONLYOFFICE target routing is internal-only; open and focus the intended file first.",
      retryable: false,
    });
    expect(sent).toBe(false);
  });

  it("delivers a request to exactly the socket that owns the selected lease", async () => {
    const broker = new OnlyOfficeBroker();
    const first = socket("first");
    const second = socket("second");
    broker.updateStatus(
      "session-1",
      { type: "onlyoffice_status", document: activeDocument() },
      first,
    );
    broker.updateStatus("session-1", { type: "onlyoffice_status", document: null }, second);
    const recipients: ServerWebSocket<SocketData>[] = [];
    broker.setSender((recipient, message) => {
      recipients.push(recipient);
      if (message.type !== "onlyoffice_request") throw new Error("Expected Office request");
      broker.resolveResponse("session-1", message.request_id, recipient, true, {
        text: "selected",
      });
    });

    await expect(
      broker.requestOperation("session-1", "request-1", { type: "get_selected_text" }),
    ).resolves.toEqual({ text: "selected" });
    expect(recipients).toEqual([first]);
  });

  it("reuses the settled result for the same idempotency key", async () => {
    const broker = new OnlyOfficeBroker();
    const browser = socket("browser");
    broker.updateStatus(
      "session-1",
      { type: "onlyoffice_status", document: activeDocument() },
      browser,
    );
    let sends = 0;
    broker.setSender((recipient, message) => {
      sends += 1;
      if (message.type === "onlyoffice_request") {
        broker.resolveResponse("session-1", message.request_id, recipient, true, { ok: true });
      }
    });

    await broker.requestOperation("session-1", "same-request", { type: "get_selected_text" });
    await broker.requestOperation("session-1", "same-request", { type: "get_selected_text" });
    expect(sends).toBe(1);
  });

  it("rejects writes for a read-only editor before contacting the browser", async () => {
    const broker = new OnlyOfficeBroker();
    const browser = socket("browser");
    broker.updateStatus(
      "session-1",
      { type: "onlyoffice_status", document: activeDocument(false) },
      browser,
    );
    let sent = false;
    broker.setSender(() => {
      sent = true;
    });

    await expect(
      broker.requestOperation("session-1", "write-1", {
        type: "append_text",
        text: "blocked",
        trackChanges: true,
      }),
    ).rejects.toThrow("read-only");
    expect(sent).toBe(false);
  });

  it("can target an unopened file through one connected browser", async () => {
    const broker = new OnlyOfficeBroker();
    const browser = socket("browser");
    broker.updateStatus("session-1", { type: "onlyoffice_status", document: null }, browser);
    broker.setSender((recipient, message) => {
      if (message.type !== "onlyoffice_request") throw new Error("Expected Office request");
      expect(message.target).toEqual({ mountId: "mount-1", path: "Budget.xlsx", closeAfter: true });
      broker.resolveResponse("session-1", message.request_id, recipient, true, { values: [[1]] });
    });

    await expect(
      broker.requestOperation(
        "session-1",
        "read-sheet",
        { type: "get_range_values", range: "A1" },
        { mountId: "mount-1", path: "Budget.xlsx", closeAfter: true },
      ),
    ).resolves.toEqual({ values: [[1]] });
  });

  it("can open a target temporarily while another document is in the foreground", async () => {
    const broker = new OnlyOfficeBroker();
    const browser = socket("browser");
    broker.updateStatus(
      "session-1",
      { type: "onlyoffice_status", document: activeDocument() },
      browser,
    );
    broker.setSender((recipient, message) => {
      if (message.type !== "onlyoffice_request") throw new Error("Expected Office request");
      expect(message.target?.path).toBe("Budget.xlsx");
      broker.resolveResponse("session-1", message.request_id, recipient, true, { values: [[2]] });
    });

    await expect(
      broker.requestOperation(
        "session-1",
        "read-other-sheet",
        { type: "get_range_values", range: "A1" },
        { mountId: "mount-1", path: "Budget.xlsx", closeAfter: true },
      ),
    ).resolves.toEqual({ values: [[2]] });
  });
});

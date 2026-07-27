// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pluginSource = readFileSync(
  resolve(process.cwd(), "public/onlyoffice-plugin/plugin.js"),
  "utf8",
);

type PluginMessage = {
  protocol: string;
  pluginGuid: string;
  pluginInstanceId: string;
  type: string;
  requestId?: string;
  ok?: boolean;
  result?: {
    beforeCount?: number;
    afterCount?: number;
  };
  error?: string;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ONLYOFFICE plugin Word replacement verification", () => {
  it("accepts replacements that retain the search text or only change its case", async () => {
    let documentHtml = "<p>ACME</p>";
    const posted: PluginMessage[] = [];
    const plugin = {
      info: { editorType: "word" },
      executeMethod: vi.fn(
        (
          name: string,
          args: Array<Record<string, unknown>> | null,
          callback: (result: unknown) => void,
        ) => {
          if (name === "GetFileHTML") {
            callback(documentHtml);
            return;
          }
          if (name === "SearchAndReplace") {
            const options = args?.[0] || {};
            const search = String(options.searchString || "");
            const replacement = String(options.replaceString || "");
            documentHtml = documentHtml.replace(
              new RegExp(search, options.matchCase === true ? "g" : "gi"),
              replacement,
            );
            callback(true);
            return;
          }
          throw new Error(`Unexpected method: ${name}`);
        },
      ),
      callCommand: vi.fn(
        (
          command: () => unknown,
          _close: boolean,
          _recalculate: boolean,
          callback: (result: unknown) => void,
        ) => callback(command()),
      ),
    };
    Object.defineProperty(window, "Asc", {
      configurable: true,
      value: { plugin, scope: {} },
    });
    Object.defineProperty(window, "Api", {
      configurable: true,
      value: {
        GetDocument: () => ({
          SetTrackRevisions: vi.fn(),
        }),
      },
    });
    vi.spyOn(window, "postMessage").mockImplementation((message) => {
      posted.push(message as PluginMessage);
    });
    const interval = vi
      .spyOn(window, "setInterval")
      .mockReturnValue(1 as unknown as ReturnType<typeof window.setInterval>);
    const timeout = vi
      .spyOn(window, "setTimeout")
      .mockReturnValue(2 as unknown as ReturnType<typeof window.setTimeout>);
    window.eval(pluginSource);
    interval.mockRestore();
    timeout.mockRestore();

    (
      window as typeof window & {
        Asc: { plugin: { init(): void } };
      }
    ).Asc.plugin.init();
    const ready = posted.find((message) => message.type === "READY");
    expect(ready).toBeDefined();

    const invoke = async (
      requestId: string,
      searchText: string,
      replaceText: string,
      matchCase = false,
    ) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          source: window,
          origin: window.location.origin,
          data: {
            protocol: ready!.protocol,
            pluginGuid: ready!.pluginGuid,
            pluginInstanceId: ready!.pluginInstanceId,
            type: "INVOKE",
            requestId,
            payload: {
              type: "replace_all_text",
              searchText,
              replaceText,
              matchCase,
              trackChanges: true,
            },
          },
        }),
      );
      await vi.waitFor(() => {
        expect(posted.some((message) => message.requestId === requestId)).toBe(true);
      });
      return posted.find((message) => message.requestId === requestId)!;
    };

    await expect(invoke("expanded", "ACME", "ACME Corp")).resolves.toMatchObject({
      ok: true,
      result: { beforeCount: 1, afterCount: 1 },
    });

    documentHtml = "<p>foo</p>";
    await expect(invoke("case-only", "foo", "FOO")).resolves.toMatchObject({
      ok: true,
      result: { beforeCount: 1, afterCount: 1 },
    });
  });
});

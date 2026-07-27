import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  filterEntries,
  getExpectedBrowserMessages,
  getExtensionEvents,
  getIncomingPiRpcMessages,
  getOutgoingPiRpcMessages,
  loadRecording,
  parseRecordingContent,
} from "./replay.js";
import type { RecordingEntry, RecordingHeader } from "./recorder.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "replay-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeHeader(overrides: Partial<RecordingHeader> = {}): RecordingHeader {
  return {
    _header: true,
    version: 2,
    session_id: "test-session",
    backend_type: "pi",
    transport: "pi-rpc",
    started_at: 1_739_654_400_000,
    cwd: "/project",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<RecordingEntry> = {}): RecordingEntry {
  return {
    ts: Date.now(),
    dir: "in",
    raw: '{"type":"get_state","id":"rpc-1"}',
    ch: "pi-rpc",
    ...overrides,
  };
}

function writeRecording(
  header: RecordingHeader,
  entries: RecordingEntry[],
  filename = "test.jsonl",
): string {
  const path = join(tempDir, filename);
  writeFileSync(
    path,
    [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join("\n") + "\n",
  );
  return path;
}

describe("native Pi recording loading", () => {
  it("parses v2 pi-rpc, browser, extension, and lifecycle entries", () => {
    const path = writeRecording(makeHeader(), [
      makeEntry(),
      makeEntry({
        dir: "out",
        ch: "browser",
        raw: JSON.stringify({
          type: "run_state",
          state: "ready",
          generation: 1,
          timestamp: 10,
        }),
      }),
      makeEntry({
        ch: "extension",
        raw: '{"type":"extension_ready","mode":"agent"}',
      }),
      makeEntry({
        ch: "pi-rpc",
        raw: "",
        event: "process_ready",
        meta: { generation: 1 },
      }),
    ]);

    const recording = loadRecording(path);

    expect(recording.header).toMatchObject({
      version: 2,
      backend_type: "pi",
      transport: "pi-rpc",
    });
    expect(recording.entries.map((entry) => entry.ch)).toEqual([
      "pi-rpc",
      "browser",
      "extension",
      "pi-rpc",
    ]);
  });

  it.each([
    { version: 1, backend_type: "pi", transport: "pi-rpc" },
    { version: 2, backend_type: "other", transport: "pi-rpc" },
    { version: 2, backend_type: "pi", transport: "sdk" },
  ])("rejects non-Pi v2 authority %#", (authority) => {
    const content = JSON.stringify({ ...makeHeader(), ...authority }) + "\n";
    expect(() => parseRecordingContent(content)).toThrow("Invalid Pi recording header");
  });

  it("rejects CRLF and blank frames", () => {
    expect(() => parseRecordingContent(`${JSON.stringify(makeHeader())}\r\n`)).toThrow("LF JSONL");
    expect(() => parseRecordingContent(`${JSON.stringify(makeHeader())}\n\n`)).toThrow(
      "blank JSONL",
    );
  });

  it("rejects unknown channels and malformed raw frames", () => {
    const badChannel = {
      ...makeEntry(),
      ch: "cli",
    };
    expect(() =>
      parseRecordingContent(`${JSON.stringify(makeHeader())}\n${JSON.stringify(badChannel)}\n`),
    ).toThrow("Malformed Pi recording entry");

    expect(() =>
      parseRecordingContent(
        `${JSON.stringify(makeHeader())}\n${JSON.stringify(makeEntry({ raw: "not-json" }))}\n`,
      ),
    ).toThrow("Malformed recorded JSONL frame");
  });

  it("allows only one truncated final entry when loading a file", () => {
    const path = join(tempDir, "truncated.jsonl");
    writeFileSync(path, `${JSON.stringify(makeHeader())}\n${JSON.stringify(makeEntry())}\n{"ts":`);

    expect(loadRecording(path).entries).toHaveLength(1);
    expect(() =>
      parseRecordingContent(
        `${JSON.stringify(makeHeader())}\n{"ts":\n${JSON.stringify(makeEntry())}\n`,
      ),
    ).toThrow("Malformed JSON");
  });

  it("does not treat a complete invalid final entry as truncation", () => {
    const path = join(tempDir, "invalid-final-entry.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify(makeHeader())}\n${JSON.stringify({
        ...makeEntry(),
        ch: "unknown",
      })}\n`,
    );
    expect(() => loadRecording(path)).toThrow("Malformed Pi recording entry");
  });

  it("preserves exact raw JSONL frame bytes inside entries", () => {
    const raw = '{"type":"get_state",  "id": "rpc-1"}';
    const path = writeRecording(makeHeader(), [makeEntry({ raw })]);
    expect(loadRecording(path).entries[0]?.raw).toBe(raw);
  });
});

describe("recording channel queries", () => {
  const entries = [
    makeEntry({ dir: "in", ch: "pi-rpc", raw: '{"type":"response","id":"1"}' }),
    makeEntry({ dir: "out", ch: "pi-rpc", raw: '{"type":"get_state","id":"1"}' }),
    makeEntry({
      dir: "out",
      ch: "browser",
      raw: '{"type":"run_state","state":"ready","generation":1,"timestamp":1}',
    }),
    makeEntry({
      dir: "in",
      ch: "extension",
      raw: '{"type":"extension_ready"}',
    }),
    makeEntry({
      dir: "in",
      ch: "pi-rpc",
      raw: "",
      event: "process_ready",
    }),
  ];

  it("filters data frames without mixing lifecycle records", () => {
    expect(filterEntries(entries, "in", "pi-rpc")).toHaveLength(1);
    expect(getExpectedBrowserMessages(entries)).toHaveLength(1);
  });

  it("returns both Pi RPC directions and trusted-extension events", () => {
    expect(getIncomingPiRpcMessages(entries)).toEqual(['{"type":"response","id":"1"}']);
    expect(getOutgoingPiRpcMessages(entries)).toEqual(['{"type":"get_state","id":"1"}']);
    expect(getExtensionEvents(entries, "in")).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import type { RecordingEntry } from "../recorder.js";
import type { Recording } from "../replay.js";
import { analyzeDisconnections, buildTimeline } from "./diagnostics.js";

function makeRecording(entries: Partial<RecordingEntry>[]): Recording {
  return {
    header: {
      _header: true,
      version: 2,
      session_id: "test",
      backend_type: "pi",
      transport: "pi-rpc",
      started_at: 0,
      cwd: "/",
    },
    entries: entries.map((entry) => ({
      ts: entry.ts ?? 0,
      dir: entry.dir ?? "in",
      raw: entry.raw ?? "",
      ch: entry.ch ?? "pi-rpc",
      ...(entry.event ? { event: entry.event } : {}),
      ...(entry.meta ? { meta: entry.meta } : {}),
    })),
  };
}

describe("Pi recording diagnostics", () => {
  it("builds a timeline across pi-rpc, browser, and extension channels", () => {
    const timeline = buildTimeline(
      makeRecording([
        { ts: 500, ch: "pi-rpc", event: "process_ready" },
        {
          ts: 300,
          ch: "browser",
          dir: "out",
          raw: JSON.stringify({
            type: "run_state",
            state: "running",
            generation: 1,
            timestamp: 300,
          }),
        },
        {
          ts: 400,
          ch: "extension",
          raw: '{"type":"extension_ready","mode":"agent"}',
        },
        { ts: 200, ch: "browser", event: "ws_open" },
      ]),
    );

    expect(timeline.map(({ channel, event }) => ({ channel, event }))).toEqual([
      { channel: "browser", event: "ws_open" },
      { channel: "browser", event: "run_state:running" },
      { channel: "extension", event: "extension:extension_ready" },
      { channel: "pi-rpc", event: "process_ready" },
    ]);
  });

  it("detects a Pi process outage and reconnect", () => {
    const report = analyzeDisconnections(
      makeRecording([
        { ts: 100, ch: "pi-rpc", event: "process_ready" },
        {
          ts: 1_000,
          ch: "pi-rpc",
          event: "process_exit",
          meta: { code: 137, reason: "signal" },
        },
        { ts: 5_000, ch: "pi-rpc", event: "process_ready" },
      ]),
    );

    expect(report).toMatchObject({
      backendType: "pi",
      totalDisconnections: 1,
      disconnections: [
        {
          channel: "pi-rpc",
          closeCode: 137,
          closeReason: "signal",
          reconnectedAt: 5_000,
          gapMs: 4_000,
        },
      ],
    });
    expect(report.patterns).toContain("pi_rpc_only_disconnects:1");
  });

  it("detects browser WebSocket outages independently", () => {
    const report = analyzeDisconnections(
      makeRecording([
        { ts: 1_000, ch: "browser", event: "ws_close", meta: { code: 1006 } },
        { ts: 3_000, ch: "browser", event: "ws_open" },
      ]),
    );

    expect(report.disconnections[0]).toMatchObject({
      channel: "browser",
      closeCode: 1006,
      gapMs: 2_000,
    });
    expect(report.patterns).toContain("browser_only_disconnects:1");
  });

  it("does not diagnose a normal run_state stopped as a disconnect", () => {
    const report = analyzeDisconnections(
      makeRecording([
        {
          ts: 100,
          dir: "out",
          ch: "browser",
          raw: '{"type":"run_state","state":"ready","generation":1,"timestamp":100}',
        },
        {
          ts: 200,
          dir: "out",
          ch: "browser",
          raw: '{"type":"run_state","state":"stopped","generation":1,"timestamp":200}',
        },
      ]),
    );

    expect(report.totalDisconnections).toBe(0);
    expect(report.patterns).toContain("no_disconnection_issues");
  });

  it("reports long gaps only for inbound Pi RPC data frames", () => {
    const report = analyzeDisconnections(
      makeRecording([
        {
          ts: 1_000,
          dir: "in",
          ch: "pi-rpc",
          raw: '{"type":"agent_start"}',
        },
        {
          ts: 61_000,
          dir: "in",
          ch: "pi-rpc",
          raw: '{"type":"agent_end"}',
        },
        {
          ts: 120_000,
          dir: "in",
          ch: "extension",
          raw: '{"type":"progress"}',
        },
      ]),
    );

    expect(report.dataGaps).toEqual([
      expect.objectContaining({
        channel: "pi-rpc",
        gapMs: 60_000,
      }),
    ]);
    expect(report.patterns).toContain("unexplained_pi_rpc_gaps:1");
  });

  it("detects repeated rapid Pi RPC reconnections", () => {
    const entries: Partial<RecordingEntry>[] = [];
    for (const base of [1_000, 25_000, 50_000]) {
      entries.push(
        { ts: base, ch: "pi-rpc", event: "transport_error" },
        { ts: base + 1_000, ch: "pi-rpc", event: "reconnect_success" },
      );
    }

    const report = analyzeDisconnections(makeRecording(entries));
    expect(report.totalDisconnections).toBe(3);
    expect(report.patterns).toContain("rapid_reconnects:3");
  });
});

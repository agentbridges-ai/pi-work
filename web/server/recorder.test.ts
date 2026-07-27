import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionRecorder, RecorderManager } from "./recorder.js";
import { UserDiskQuota } from "./user-disk-quota.js";

let tempDir: string;
const originalNodeEnv = process.env.NODE_ENV;
const originalRecordEnv = process.env.PIWORK_RECORD;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "recorder-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalRecordEnv === undefined) delete process.env.PIWORK_RECORD;
  else process.env.PIWORK_RECORD = originalRecordEnv;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

/**
 * Create a fake JSONL recording file with a given number of entry lines.
 * Returns the full path. The header counts as 1 line, so total lines = 1 + entryCount.
 */
function createFakeRecording(
  dir: string,
  filename: string,
  entryCount: number,
  mtime?: Date,
): string {
  const header = JSON.stringify({
    _header: true,
    version: 2,
    session_id: "fake",
    backend_type: "pi",
    transport: "pi-rpc",
    started_at: Date.now(),
    cwd: "/fake",
  });
  const entry = JSON.stringify({ ts: Date.now(), dir: "in", raw: "x", ch: "pi-rpc" });
  const lines = [header, ...Array(entryCount).fill(entry)];
  const filePath = join(dir, filename);
  writeFileSync(filePath, lines.join("\n") + "\n");
  if (mtime) {
    utimesSync(filePath, mtime, mtime);
  }
  return filePath;
}

// ─── SessionRecorder ─────────────────────────────────────────────────────────

describe("SessionRecorder", () => {
  it("writes a header as the first line with correct metadata", () => {
    const rec = new SessionRecorder("sess-1", "pi", "/project", tempDir);
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(1);

    const header = JSON.parse(lines[0]);
    expect(header._header).toBe(true);
    expect(header.version).toBe(2);
    expect(header.session_id).toBe("sess-1");
    expect(header.backend_type).toBe("pi");
    expect(header.transport).toBe("pi-rpc");
    expect(header.cwd).toBe("/project");
    expect(typeof header.started_at).toBe("number");
    if (process.platform !== "win32") expect(statSync(rec.filePath).mode & 0o777).toBe(0o600);
  });

  it("preserves raw strings exactly without re-serialization", () => {
    // The raw string has intentional formatting (extra spaces, specific order)
    // that must be preserved verbatim — not re-parsed and re-serialized.
    const rawMsg = '{"type":"system",  "subtype":"init", "extra_field": true}';
    const rec = new SessionRecorder("sess-2", "pi", "/project", tempDir);
    rec.record("in", rawMsg, "pi-rpc");
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);

    const entry = JSON.parse(lines[1]);
    expect(entry.raw).toBe(rawMsg);
  });

  it("records entries with monotonically increasing timestamps", () => {
    const rec = new SessionRecorder("sess-3", "pi", "/project", tempDir);
    rec.record("in", '{"type":"get_state"}', "pi-rpc");
    rec.record("out", '{"type":"response"}', "pi-rpc");
    rec.record("in", '{"type":"session_subscribe"}', "browser");
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(4);

    const entries = lines.slice(1).map((l) => JSON.parse(l));
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].ts).toBeGreaterThanOrEqual(entries[i - 1].ts);
    }
  });

  it("records direction and channel correctly", () => {
    const rec = new SessionRecorder("sess-4", "pi", "/cwd", tempDir);
    rec.record("in", '{"type":"agent_start"}', "pi-rpc");
    rec.record("out", '{"type":"run_state"}', "browser");
    rec.close();

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    const e1 = JSON.parse(lines[1]);
    const e2 = JSON.parse(lines[2]);

    expect(e1.dir).toBe("in");
    expect(e1.ch).toBe("pi-rpc");
    expect(e2.dir).toBe("out");
    expect(e2.ch).toBe("browser");
  });

  it("does not record after close()", () => {
    const rec = new SessionRecorder("sess-5", "pi", "/cwd", tempDir);
    rec.record("in", '{"type":"before_close"}', "pi-rpc");
    rec.close();
    rec.record("in", '{"type":"after_close"}', "pi-rpc");

    const lines = readFileSync(rec.filePath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1]).raw).toBe('{"type":"before_close"}');
  });

  it("redacts credential fields, registered values and lifecycle metadata", () => {
    const rec = new SessionRecorder("sess-secret", "pi", "/cwd", tempDir);
    rec.setSensitiveValues(["provider-secret-value"]);
    rec.record(
      "in",
      JSON.stringify({
        type: "extension_event",
        apiKey: "another-secret",
        detail: "provider-secret-value",
        nested: { headers: { Authorization: "Bearer mcp-secret" } },
      }),
      "extension",
    );
    rec.recordEvent("process_ready", "pi-rpc", {
      generation: 2,
      authorization: "Bearer lifecycle-secret",
    });
    rec.close();

    const disk = readFileSync(rec.filePath, "utf8");
    expect(disk).not.toContain("another-secret");
    expect(disk).not.toContain("provider-secret-value");
    expect(disk).not.toContain("mcp-secret");
    expect(disk).not.toContain("lifecycle-secret");
    expect(disk).toContain("[REDACTED]");
  });

  it("semantically redacts protected browser payloads and transient capabilities on disk", () => {
    const rec = new SessionRecorder("sess-protected-browser", "pi", "/cwd", tempDir);
    rec.record(
      "out",
      JSON.stringify({
        type: "user_space_request",
        request_id: "request-1",
        operation: "write_file",
        input: {
          path: "documents/private.txt",
          content: "browser-write-secret",
        },
        inputTokens: 17,
      }),
      "browser",
    );
    rec.record(
      "in",
      JSON.stringify({
        protocolVersion: 1,
        contextEpoch: 4,
        contextId: "0123456789abcdef0123456789abcdef",
        eventId: "event-1",
        kind: "user_space_response",
        payload: {
          type: "user_space_response",
          request_id: "request-1",
          ok: true,
          result: { content: "browser-read-secret", path: "documents/private.txt" },
          commit_lease: "commit-lease-secret",
          runtime_epoch: "runtime-epoch-secret",
        },
      }),
      "browser",
    );
    rec.record(
      "out",
      JSON.stringify({
        type: "user_space_blob_checkout_request",
        transfer_id: "transfer-1",
        mountId: "checkout-mount-secret",
        path: "checkout-path-secret",
        uploadUrl: "/api/user-space-transfer/s1/blob/upload?token=transfer-token-secret",
        completeUrl:
          "https://files.example.test/complete?signature=temporary-signature-secret&part=1",
        maxBytes: 1024,
      }),
      "browser",
    );
    rec.record(
      "out",
      JSON.stringify({
        type: "user_space_blob_checkin_request",
        transfer_id: "transfer-2",
        mountId: "checkin-mount-secret",
        path: "checkin-path-secret",
        baseHash: "checkin-base-hash-secret",
        baseMtime: 123456789,
        create: false,
        size: 2048,
        hash: "checkin-hash-secret",
        downloadUrl:
          "/api/user-space-transfer/s1/blob/download?capability=download-capability-secret",
        commitUrl: "/api/user-space-transfer/s1/blob/commit?token=commit-token-secret",
        completeUrl: "/api/user-space-transfer/s1/blob/complete?token=complete-token-secret",
      }),
      "browser",
    );
    rec.record(
      "out",
      JSON.stringify({
        type: "onlyoffice_request",
        request_id: "office-1",
        lease_id: "office-lease-secret",
        editor_instance_id: "office-instance-secret",
        target: { mountId: "mount-1", path: "documents/private.docx" },
        operation: {
          type: "insert_text_at_cursor",
          text: "office-write-secret",
          trackChanges: true,
        },
      }),
      "browser",
    );
    rec.record(
      "in",
      JSON.stringify({
        type: "onlyoffice_response",
        request_id: "office-1",
        ok: true,
        result: { text: "office-read-secret" },
        capability: "office-capability-secret",
      }),
      "browser",
    );
    rec.record(
      "in",
      JSON.stringify({
        type: "onlyoffice_status",
        document: {
          leaseId: "office-status-lease-secret",
          editorInstanceId: "office-status-instance-secret",
          title: "office-status-title-secret",
          mountId: "office-status-mount-secret",
          path: "office-status-path-secret",
          fileType: "docx",
          documentType: "word",
          writable: true,
          pluginReady: true,
          foreground: false,
        },
      }),
      "browser",
    );
    rec.close();

    const disk = readFileSync(rec.filePath, "utf8");
    for (const secret of [
      "browser-write-secret",
      "browser-read-secret",
      "commit-lease-secret",
      "runtime-epoch-secret",
      "checkout-mount-secret",
      "checkout-path-secret",
      "transfer-token-secret",
      "temporary-signature-secret",
      "checkin-mount-secret",
      "checkin-path-secret",
      "checkin-base-hash-secret",
      "checkin-hash-secret",
      "download-capability-secret",
      "commit-token-secret",
      "complete-token-secret",
      "office-write-secret",
      "office-read-secret",
      "office-capability-secret",
      "office-lease-secret",
      "office-instance-secret",
      "office-status-lease-secret",
      "office-status-instance-secret",
      "office-status-title-secret",
      "office-status-mount-secret",
      "office-status-path-secret",
    ]) {
      expect(disk).not.toContain(secret);
    }

    const entries = disk
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => JSON.parse(JSON.parse(line).raw));
    expect(entries[0]).toMatchObject({
      type: "user_space_request",
      request_id: "request-1",
      operation: "write_file",
      input: { redacted: true },
      inputTokens: 17,
    });
    expect(entries[1].payload).toMatchObject({
      type: "user_space_response",
      request_id: "request-1",
      ok: true,
      result: { redacted: true },
      commit_lease: "[REDACTED]",
      runtime_epoch: "[REDACTED]",
    });
    expect(entries[2]).toMatchObject({
      type: "user_space_blob_checkout_request",
      transfer_id: "transfer-1",
      mountId: "[REDACTED]",
      path: "[REDACTED]",
      uploadUrl: "/api/user-space-transfer/s1/blob/upload?[REDACTED]",
      completeUrl: "https://files.example.test/complete?[REDACTED]",
      maxBytes: 1024,
    });
    expect(entries[3]).toMatchObject({
      type: "user_space_blob_checkin_request",
      transfer_id: "transfer-2",
      mountId: "[REDACTED]",
      path: "[REDACTED]",
      baseHash: "[REDACTED]",
      baseMtime: "[REDACTED]",
      create: false,
      size: 2048,
      hash: "[REDACTED]",
      downloadUrl: "/api/user-space-transfer/s1/blob/download?[REDACTED]",
      commitUrl: "/api/user-space-transfer/s1/blob/commit?[REDACTED]",
      completeUrl: "/api/user-space-transfer/s1/blob/complete?[REDACTED]",
    });
    expect(entries[4]).toMatchObject({
      type: "onlyoffice_request",
      request_id: "office-1",
      lease_id: "[REDACTED]",
      editor_instance_id: "[REDACTED]",
      operation: { type: "insert_text_at_cursor", redacted: true },
      target: { redacted: true },
    });
    expect(entries[5]).toMatchObject({
      type: "onlyoffice_response",
      result: { redacted: true },
      capability: "[REDACTED]",
    });
    expect(entries[6]).toMatchObject({
      type: "onlyoffice_status",
      document: {
        redacted: true,
        documentType: "word",
        writable: true,
        pluginReady: true,
        foreground: false,
      },
    });
  });

  it("never writes malformed frames verbatim", () => {
    const rec = new SessionRecorder("sess-malformed", "pi", "/cwd", tempDir);
    rec.record("in", "not-json-and-maybe-sensitive", "pi-rpc");
    rec.close();
    const entry = JSON.parse(readFileSync(rec.filePath, "utf8").trim().split("\n")[1]);
    expect(JSON.parse(entry.raw)).toMatchObject({
      type: "invalid_jsonl_frame",
      bytes: Buffer.byteLength("not-json-and-maybe-sensitive"),
    });
    expect(readFileSync(rec.filePath, "utf8")).not.toContain("not-json-and-maybe-sensitive");
  });

  it("generates a filename with session ID and backend type", () => {
    const rec = new SessionRecorder("my-session", "pi", "/cwd", tempDir);
    rec.close();

    expect(rec.filePath).toContain("my-session");
    expect(rec.filePath).toContain("pi");
    expect(rec.filePath).toMatch(/\.jsonl$/);
  });

  it("tracks lineCount correctly (header + entries)", () => {
    // lineCount starts at 1 (the header), increments for each recorded entry
    const rec = new SessionRecorder("sess-lc", "pi", "/cwd", tempDir);
    expect(rec.lineCount).toBe(1);

    rec.record("in", "a", "pi-rpc");
    rec.record("in", "b", "pi-rpc");
    rec.record("out", "c", "browser");
    rec.record("in", "d", "pi-rpc");
    rec.record("out", "e", "browser");
    expect(rec.lineCount).toBe(6);

    rec.close();
    // lineCount doesn't change after close
    expect(rec.lineCount).toBe(6);
  });

  it("reserves recorder bytes and leaves no partial append when quota rejects a record", async () => {
    const quota = new UserDiskQuota({ maxBytes: 300, reservedHeadroomBytes: 10 });
    quota.addRoot(tempDir);
    await quota.reconcile();
    const rec = new SessionRecorder("sess-quota", "pi", "/cwd", tempDir, quota);
    const before = statSync(rec.filePath).size;

    expect(
      rec.record("in", JSON.stringify({ type: "agent_event", data: "x".repeat(1_000) }), "pi-rpc"),
    ).toBe(false);
    expect(statSync(rec.filePath).size).toBe(before);
    expect(quota.snapshot()).toMatchObject({ usedBytes: before, reservedBytes: 0 });
    rec.close();
  });

  it("charges successful lifecycle events to the shared disk quota", async () => {
    const quota = new UserDiskQuota({ maxBytes: 10_000, reservedHeadroomBytes: 100 });
    quota.addRoot(tempDir);
    await quota.reconcile();
    const rec = new SessionRecorder("sess-event-quota", "pi", "/cwd", tempDir, quota);

    expect(rec.recordEvent("ws_close", "browser", { code: 1006 })).toBe(true);

    const fileBytes = statSync(rec.filePath).size;
    expect(quota.snapshot()).toMatchObject({ usedBytes: fileBytes, reservedBytes: 0 });
    expect(JSON.parse(readFileSync(rec.filePath, "utf-8").trim().split("\n")[1])).toMatchObject({
      event: "ws_close",
      ch: "browser",
      meta: { code: 1006 },
    });
    rec.close();
  });
});

// ─── RecorderManager ─────────────────────────────────────────────────────────

describe("RecorderManager", () => {
  it("enabled by default when no options provided", () => {
    // Recording is always on unless explicitly disabled
    const mgr = new RecorderManager({ recordingsDir: tempDir });
    expect(mgr.isGloballyEnabled()).toBe(true);
    expect(mgr.isRecording("any-session")).toBe(true);
    mgr.closeAll();
  });

  it("defaults off in production unless explicitly enabled", () => {
    process.env.NODE_ENV = "production";
    delete process.env.PIWORK_RECORD;
    const disabled = new RecorderManager({ recordingsDir: tempDir });
    expect(disabled.isGloballyEnabled()).toBe(false);
    disabled.closeAll();

    process.env.PIWORK_RECORD = "1";
    const enabled = new RecorderManager({ recordingsDir: tempDir });
    expect(enabled.isGloballyEnabled()).toBe(true);
    enabled.closeAll();
  });

  it("respects globalEnabled: true", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    expect(mgr.isGloballyEnabled()).toBe(true);
    expect(mgr.isRecording("any-session")).toBe(true);
    mgr.closeAll();
  });

  it("does not record when disabled globally and per-session", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    expect(mgr.isRecording("sess-1")).toBe(false);

    mgr.record("sess-1", "in", "test", "pi-rpc", "pi", "/cwd");

    const files = readDirSafe(tempDir);
    expect(files.length).toBe(0);
  });

  it("fails closed without a quota cache and does not create a recording file", () => {
    const quota = new UserDiskQuota({ maxBytes: 1_000, reservedHeadroomBytes: 100 });
    quota.addRoot(tempDir);
    const mgr = new RecorderManager({
      globalEnabled: true,
      recordingsDir: tempDir,
      diskQuota: quota,
    });

    expect(() => mgr.record("sess-quota", "in", "message", "pi-rpc", "pi", "/cwd")).not.toThrow();
    expect(readDirSafe(tempDir).filter((entry) => entry.endsWith(".jsonl"))).toEqual([]);
    mgr.closeAll();
  });

  it("self-primes an unavailable quota cache for the next recording attempt", async () => {
    const quota = new UserDiskQuota({ maxBytes: 10_000, reservedHeadroomBytes: 100 });
    quota.addRoot(tempDir);
    const mgr = new RecorderManager({
      globalEnabled: true,
      recordingsDir: tempDir,
      diskQuota: quota,
    });

    mgr.record("sess-quota", "in", "first", "pi-rpc", "pi", "/cwd");
    expect(readDirSafe(tempDir).filter((entry) => entry.endsWith(".jsonl"))).toEqual([]);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        quota.snapshot();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    expect(() => quota.snapshot()).not.toThrow();
    mgr.record("sess-quota", "in", "second", "pi-rpc", "pi", "/cwd");

    expect(readDirSafe(tempDir).filter((entry) => entry.endsWith(".jsonl"))).toHaveLength(1);
    mgr.closeAll();
  });

  it("supports per-session enable/disable", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });

    expect(mgr.isRecording("sess-1")).toBe(false);

    mgr.enableForSession("sess-1");
    expect(mgr.isRecording("sess-1")).toBe(true);
    expect(mgr.isRecording("sess-2")).toBe(false);

    mgr.disableForSession("sess-1");
    expect(mgr.isRecording("sess-1")).toBe(false);
  });

  it("lazily creates a recorder on first record() call", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });

    expect(readDirSafe(tempDir).length).toBe(0);

    mgr.record("sess-1", "in", "first-msg", "pi-rpc", "pi", "/cwd");

    const files = readDirSafe(tempDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^sess-1_pi_.*\.jsonl$/);
    mgr.closeAll();
  });

  it("lazily creates a recorder for the first process lifecycle event", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });

    mgr.recordEvent(
      "sess-lifecycle",
      "process_spawn",
      "pi-rpc",
      { generation: 1, pid: 42 },
      "pi",
      "/cwd",
    );

    const files = readDirSafe(tempDir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(tempDir, files[0]!), "utf8").trim().split("\n");
    expect(JSON.parse(lines[1]!)).toMatchObject({
      event: "process_spawn",
      ch: "pi-rpc",
      meta: { generation: 1, pid: 42 },
    });
    mgr.closeAll();
  });

  it("creates separate files for concurrent sessions", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });

    mgr.record("sess-a", "in", "msg-a", "pi-rpc", "pi", "/cwd");
    mgr.record("sess-b", "in", "msg-b", "pi-rpc", "pi", "/cwd");

    const files = readDirSafe(tempDir);
    expect(files.length).toBe(2);
    expect(files.some((f) => f.includes("sess-a"))).toBe(true);
    expect(files.some((f) => f.includes("sess-b"))).toBe(true);
    mgr.closeAll();
  });

  it("stopRecording closes the recorder and removes it", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    mgr.record("sess-1", "in", "msg1", "pi-rpc", "pi", "/cwd");

    mgr.stopRecording("sess-1");

    mgr.record("sess-1", "in", "msg2", "pi-rpc", "pi", "/cwd");

    const files = readDirSafe(tempDir);
    expect(files.length).toBe(2);
    mgr.closeAll();
  });

  it("drops protected-call semantic state when a session stops or is disabled", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    const protectedStart = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "reused-call-id",
      toolName: "bash",
      args: { command: "user-space read private.txt" },
    });
    const laterOrdinaryResult = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "reused-call-id",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ordinary-after-reset" }] },
      isError: false,
    });

    mgr.enableForSession("sess-stop-state");
    mgr.record("sess-stop-state", "in", protectedStart, "pi-rpc", "pi", "/cwd");
    mgr.stopRecording("sess-stop-state");
    mgr.record("sess-stop-state", "in", laterOrdinaryResult, "pi-rpc", "pi", "/cwd");

    mgr.enableForSession("sess-disable-state");
    mgr.record("sess-disable-state", "in", protectedStart, "pi-rpc", "pi", "/cwd");
    mgr.disableForSession("sess-disable-state");
    mgr.enableForSession("sess-disable-state");
    mgr.record("sess-disable-state", "in", laterOrdinaryResult, "pi-rpc", "pi", "/cwd");
    mgr.closeAll();

    const disk = readDirSafe(tempDir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => readFileSync(join(tempDir, file), "utf8"))
      .join("\n");
    expect(disk.match(/ordinary-after-reset/gu)).toHaveLength(2);
  });

  it("getRecordingStatus returns filePath when active", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    mgr.record("sess-1", "in", "msg", "pi-rpc", "pi", "/cwd");

    const status = mgr.getRecordingStatus("sess-1");
    expect(status.filePath).toBeDefined();
    expect(status.filePath!).toMatch(/sess-1.*\.jsonl$/);
    mgr.closeAll();
  });

  it("getRecordingStatus returns empty when not active", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    const status = mgr.getRecordingStatus("sess-1");
    expect(status.filePath).toBeUndefined();
  });

  it("listRecordings returns correct metadata and line counts", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    // sess-1: header + 1 entry = 2 lines
    mgr.record("sess-1", "in", "msg", "pi-rpc", "pi", "/cwd");
    // sess-2: header + 1 entry = 2 lines
    mgr.record("sess-2", "in", "msg", "pi-rpc", "pi", "/cwd");

    const recordings = mgr.listRecordings();
    expect(recordings.length).toBe(2);

    const r1 = recordings.find((r) => r.sessionId === "sess-1");
    expect(r1).toBeDefined();
    expect(r1!.backendType).toBe("pi");
    expect(r1!.lines).toBe(2);

    const r2 = recordings.find((r) => r.sessionId === "sess-2");
    expect(r2).toBeDefined();
    expect(r2!.backendType).toBe("pi");
    expect(r2!.lines).toBe(2);
    mgr.closeAll();
  });

  it("listRecordings returns empty array when directory does not exist", () => {
    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: join(tempDir, "nonexistent"),
    });
    expect(mgr.listRecordings()).toEqual([]);
  });

  it("closeAll closes all active recorders and stops cleanup timer", () => {
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    mgr.record("sess-1", "in", "msg", "pi-rpc", "pi", "/cwd");
    mgr.record("sess-2", "in", "msg", "pi-rpc", "pi", "/cwd");

    mgr.closeAll();

    expect(mgr.getRecordingStatus("sess-1").filePath).toBeUndefined();
    expect(mgr.getRecordingStatus("sess-2").filePath).toBeUndefined();
  });

  it("disableForSession also stops and closes the recorder", () => {
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    mgr.enableForSession("sess-1");
    mgr.record("sess-1", "in", "msg", "pi-rpc", "pi", "/cwd");

    expect(mgr.getRecordingStatus("sess-1").filePath).toBeDefined();

    mgr.disableForSession("sess-1");

    expect(mgr.getRecordingStatus("sess-1").filePath).toBeUndefined();
  });

  it("retains redaction values when an active session recording is stopped and restarted", () => {
    const secret = "provider-secret-after-restart";
    const mgr = new RecorderManager({ globalEnabled: false, recordingsDir: tempDir });
    mgr.addSensitiveValues("sess-1", [secret]);
    mgr.enableForSession("sess-1");
    mgr.record("sess-1", "in", JSON.stringify({ detail: secret }), "pi-rpc", "pi", "/cwd");
    mgr.disableForSession("sess-1");
    mgr.enableForSession("sess-1");
    mgr.record("sess-1", "in", JSON.stringify({ detail: secret }), "pi-rpc", "pi", "/cwd");
    mgr.closeAll();

    expect(readDirSafe(tempDir)).toHaveLength(2);
    for (const filename of readDirSafe(tempDir)) {
      expect(readFileSync(join(tempDir, filename), "utf8")).not.toContain(secret);
    }
  });

  it("disableForSession overrides globalEnabled and prevents new recordings", () => {
    // When globalEnabled is true, disableForSession must still stop recording
    // for that specific session by adding it to the perSessionDisabled set.
    const mgr = new RecorderManager({ globalEnabled: true, recordingsDir: tempDir });
    mgr.record("sess-1", "in", "msg1", "pi-rpc", "pi", "/cwd");

    expect(mgr.isRecording("sess-1")).toBe(true);

    mgr.disableForSession("sess-1");

    // Session is no longer recording despite globalEnabled=true
    expect(mgr.isRecording("sess-1")).toBe(false);

    // New record() calls should be no-ops (no new file created)
    const filesBefore = readDirSafe(tempDir).length;
    mgr.record("sess-1", "in", "msg2", "pi-rpc", "pi", "/cwd");
    expect(readDirSafe(tempDir).length).toBe(filesBefore);

    // Re-enabling should work
    mgr.enableForSession("sess-1");
    expect(mgr.isRecording("sess-1")).toBe(true);

    mgr.closeAll();
  });

  it("getMaxLines returns configured limit", () => {
    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: tempDir,
      maxLines: 42,
    });
    expect(mgr.getMaxLines()).toBe(42);
  });

  it("exposes the byte and retention policy", () => {
    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: tempDir,
      maxSessionBytes: 100,
      maxUserBytes: 500,
      retentionDays: 3,
    });
    expect(mgr.getRetentionPolicy()).toEqual({
      maxSessionBytes: 100,
      maxUserBytes: 500,
      retentionDays: 3,
    });
  });
});

// ─── Cleanup / Rotation ─────────────────────────────────────────────────────

describe("cleanup / rotation", () => {
  it("removes recordings older than the retention window", () => {
    const now = Date.now();
    createFakeRecording(
      tempDir,
      "expired_pi_old.jsonl",
      1,
      new Date(now - 8 * 24 * 60 * 60 * 1000),
    );
    createFakeRecording(tempDir, "current_pi_new.jsonl", 1, new Date(now));
    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: tempDir,
      maxLines: 1_000,
      maxSessionBytes: 1_000_000,
      maxUserBytes: 1_000_000,
      retentionDays: 7,
    });

    expect(mgr.cleanup()).toBe(1);
    expect(readDirSafe(tempDir)).toEqual(["current_pi_new.jsonl"]);
  });

  it("rotates an active recorder at the per-session byte limit", () => {
    const mgr = new RecorderManager({
      globalEnabled: true,
      recordingsDir: tempDir,
      maxSessionBytes: 150,
      maxUserBytes: 10_000,
      retentionDays: 7,
    });

    mgr.record("sess-rotate", "in", "x".repeat(200), "pi-rpc", "pi", "/cwd");

    expect(mgr.getRecordingStatus("sess-rotate").filePath).toBeUndefined();
    expect(
      readDirSafe(tempDir).filter((name) => name.endsWith(".jsonl")).length,
    ).toBeLessThanOrEqual(1);
    mgr.closeAll();
  });

  it("rejects an oversized frame before the file exceeds the per-session limit", () => {
    const maxSessionBytes = 512;
    const mgr = new RecorderManager({
      globalEnabled: true,
      recordingsDir: tempDir,
      maxSessionBytes,
      maxUserBytes: 10_000,
      retentionDays: 7,
    });

    mgr.record(
      "sess-hard-cap",
      "in",
      JSON.stringify({ type: "agent_event", data: "x".repeat(4_096) }),
      "pi-rpc",
      "pi",
      "/cwd",
    );

    const recordings = readDirSafe(tempDir).filter((name) => name.endsWith(".jsonl"));
    for (const filename of recordings) {
      expect(statSync(join(tempDir, filename)).size).toBeLessThanOrEqual(maxSessionBytes);
      expect(readFileSync(join(tempDir, filename), "utf-8")).not.toContain("x".repeat(128));
    }
    expect(mgr.getRecordingStatus("sess-hard-cap").filePath).toBeUndefined();
    mgr.closeAll();
  });

  it("enforces the per-user byte cap across concurrently active sessions", () => {
    const maxUserBytes = 700;
    const mgr = new RecorderManager({
      globalEnabled: true,
      recordingsDir: tempDir,
      maxSessionBytes: 600,
      maxUserBytes,
      retentionDays: 7,
    });

    mgr.record("session-a", "in", "a".repeat(220), "pi-rpc", "pi", "/cwd");
    mgr.record("session-b", "in", "b".repeat(220), "pi-rpc", "pi", "/cwd");
    mgr.record("session-a", "in", "c".repeat(220), "pi-rpc", "pi", "/cwd");

    const total = readDirSafe(tempDir)
      .filter((name) => name.endsWith(".jsonl"))
      .reduce((sum, name) => sum + statSync(join(tempDir, name)).size, 0);
    expect(total).toBeLessThanOrEqual(maxUserBytes);
    mgr.closeAll();
  });

  it("deletes oldest files when total lines exceed maxLines", () => {
    // Create 3 files with 10 entries each (= 11 lines each including header, 33 total)
    // Use different mtimes so we control which is "oldest"
    const now = Date.now();
    createFakeRecording(tempDir, "old_pi_2025-01-01.jsonl", 10, new Date(now - 3000));
    createFakeRecording(tempDir, "mid_pi_2025-01-02.jsonl", 10, new Date(now - 2000));
    createFakeRecording(tempDir, "new_pi_2025-01-03.jsonl", 10, new Date(now - 1000));

    // maxLines = 20 → total 33 lines exceeds limit → should delete oldest first
    const mgr = new RecorderManager({
      globalEnabled: false, // don't start auto-cleanup timer
      recordingsDir: tempDir,
      maxLines: 20,
    });

    const deleted = mgr.cleanup();

    // Should have deleted at least the oldest file (11 lines), bringing total to 22,
    // still > 20, so the mid file (11 lines) gets deleted too → total 11 lines
    expect(deleted).toBe(2);

    const remaining = readDirSafe(tempDir);
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toContain("new_pi");
  });

  it("does not delete files from active recording sessions", () => {
    // Create an old file that would normally be deleted
    const now = Date.now();
    createFakeRecording(tempDir, "stale_pi_2025-01-01.jsonl", 10, new Date(now - 3000));

    // Start an active recording — this file's path will be in the active set
    const mgr = new RecorderManager({
      globalEnabled: true,
      recordingsDir: tempDir,
      maxLines: 5, // Very low limit to force cleanup
    });
    mgr.record("active-sess", "in", "msg", "pi-rpc", "pi", "/cwd");

    // Now cleanup should delete the stale file but NOT the active recording's file
    const deleted = mgr.cleanup();

    // stale file deleted
    expect(existsSync(join(tempDir, "stale_pi_2025-01-01.jsonl"))).toBe(false);

    // active session's file should still exist
    const status = mgr.getRecordingStatus("active-sess");
    expect(status.filePath).toBeDefined();
    expect(existsSync(status.filePath!)).toBe(true);

    mgr.closeAll();
  });

  it("is a no-op when total lines are under the limit", () => {
    // 2 files × 3 entries = 2 × 4 lines = 8 total, well under 100
    createFakeRecording(tempDir, "a_pi_2025-01-01.jsonl", 3);
    createFakeRecording(tempDir, "b_pi_2025-01-02.jsonl", 3);

    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: tempDir,
      maxLines: 100,
    });

    const deleted = mgr.cleanup();
    expect(deleted).toBe(0);

    expect(readDirSafe(tempDir).length).toBe(2);
  });

  it("handles empty recordings directory gracefully", () => {
    const mgr = new RecorderManager({
      globalEnabled: false,
      recordingsDir: tempDir,
      maxLines: 10,
    });

    const deleted = mgr.cleanup();
    expect(deleted).toBe(0);
  });

  it("runs cleanup at construction when globally enabled", () => {
    // Pre-fill the directory over the limit
    const now = Date.now();
    createFakeRecording(tempDir, "old_pi_2025-01-01.jsonl", 20, new Date(now - 2000));
    createFakeRecording(tempDir, "new_pi_2025-01-02.jsonl", 5, new Date(now - 1000));

    // Total = 21 + 6 = 27 lines, maxLines = 10
    // Constructor should run cleanup immediately, deleting the old file
    const mgr = new RecorderManager({
      globalEnabled: true,
      recordingsDir: tempDir,
      maxLines: 10,
    });

    const remaining = readDirSafe(tempDir);
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toContain("new_pi");

    mgr.closeAll();
  });
});

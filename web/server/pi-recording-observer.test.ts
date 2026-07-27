import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createPiRecordingObserver } from "./pi-recording-observer.js";
import { PiRpcTransport } from "./pi-rpc-transport.js";
import { loadRecording } from "./replay.js";
import { RecorderManager } from "./recorder.js";

const roots: string[] = [];
const ROOT_SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD_SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }
  assertion();
}

function runtime(sessionId: string, observer: ReturnType<typeof createPiRecordingObserver>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const writes: string[] = [];
  stdin.on("data", (chunk) => writes.push(chunk.toString("utf8")));
  const transport = new PiRpcTransport({
    sessionId,
    generation: 1,
    stdin,
    stdout,
    observer,
    requestTimeoutMs: 1_000,
  });
  return { transport, stdout, writes };
}

describe("Pi recording production observer", () => {
  it("archives root and child RPC, extension, and lifecycle records under the root with redaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recording-observer-"));
    roots.push(root);
    const recordingsDir = join(root, "recordings-root");
    const sessionCwd = join(root, "session", "workspace");
    const recorder = new RecorderManager({
      globalEnabled: true,
      recordingsDir,
      recordingsDirForSession: (sessionId) => join(recordingsDir, sessionId, "recordings"),
    });
    const providerSecret = "provider-secret-value";
    const mcpSecret = "mcp-secret-value";
    const childCapability = "child-capability-value";
    recorder.addSensitiveValues(ROOT_SESSION, [providerSecret, mcpSecret, childCapability]);
    const observer = createPiRecordingObserver({
      recorder,
      recordingSessionId: ROOT_SESSION,
      cwd: sessionCwd,
    });

    observer.onLifecycle?.(
      { type: "generation_change", meta: { previousGeneration: 0 } },
      { sessionId: ROOT_SESSION, generation: 1 },
    );
    observer.onLifecycle?.(
      { type: "process_spawn", meta: { pid: 101 } },
      { sessionId: CHILD_SESSION, generation: 1 },
    );

    const rootRuntime = runtime(ROOT_SESSION, observer);
    const childRuntime = runtime(CHILD_SESSION, observer);
    await rootRuntime.transport.sendInput({ type: "abort" });

    const state = childRuntime.transport.getState();
    await eventually(() => expect(childRuntime.writes).toHaveLength(1));
    const requestId = JSON.parse(childRuntime.writes[0]!).id;
    childRuntime.stdout.write(
      `${JSON.stringify({
        id: requestId,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: CHILD_SESSION,
          thinkingLevel: "medium",
          isStreaming: false,
          isCompacting: false,
          steeringMode: "all",
          followUpMode: "all",
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        },
      })}\n`,
    );
    await expect(state).resolves.toMatchObject({ sessionId: CHILD_SESSION });

    childRuntime.stdout.write(
      `${JSON.stringify({
        type: "extension_ui_request",
        id: "status-1",
        method: "setStatus",
        statusKey: "piwork.task",
        statusText: providerSecret,
      })}\n`,
    );
    childRuntime.stdout.write(
      `${JSON.stringify({
        type: "extension_error",
        extensionPath: "/trusted/pi-extension.ts",
        event: "task",
        error: mcpSecret,
      })}\n`,
    );
    await childRuntime.transport.sendExtensionUiResponse({
      type: "extension_ui_response",
      id: "ask-1",
      value: childCapability,
    });
    observer.onLifecycle?.({ type: "process_ready" }, { sessionId: CHILD_SESSION, generation: 1 });
    observer.onLifecycle?.(
      { type: "process_exit", meta: { exitCode: 0, signal: null } },
      { sessionId: CHILD_SESSION, generation: 1 },
    );
    await eventually(() => {
      const status = recorder.getRecordingStatus(ROOT_SESSION);
      expect(status.filePath).toBeDefined();
      expect(loadRecording(status.filePath!).entries.length).toBeGreaterThanOrEqual(10);
    });

    rootRuntime.transport.dispose();
    childRuntime.transport.dispose();
    const filePath = recorder.getRecordingStatus(ROOT_SESSION).filePath!;
    recorder.closeAll();
    const recording = loadRecording(filePath);
    const disk = readFileSync(filePath, "utf8");
    const recordingFiles = readdirSync(join(recordingsDir, ROOT_SESSION, "recordings"));

    expect(recording.header).toMatchObject({
      session_id: ROOT_SESSION,
      backend_type: "pi",
      transport: "pi-rpc",
      cwd: sessionCwd,
    });
    expect(recordingFiles).toHaveLength(1);
    expect(disk).not.toContain(providerSecret);
    expect(disk).not.toContain(mcpSecret);
    expect(disk).not.toContain(childCapability);
    expect(disk).not.toContain("pi_bootstrap_payload");
    expect(disk).toContain("[REDACTED]");

    const piFrames = recording.entries.filter((entry) => entry.ch === "pi-rpc" && !entry.event);
    expect(piFrames.some((entry) => entry.dir === "out")).toBe(true);
    expect(piFrames.some((entry) => entry.dir === "in")).toBe(true);
    expect(piFrames.every((entry) => !entry.raw.includes("\n"))).toBe(true);
    expect(piFrames.some((entry) => entry.meta?.runtimeSessionId === ROOT_SESSION)).toBe(true);
    expect(piFrames.some((entry) => entry.meta?.runtimeSessionId === CHILD_SESSION)).toBe(true);

    const extensionFrames = recording.entries.filter(
      (entry) => entry.ch === "extension" && !entry.event,
    );
    expect(extensionFrames).toHaveLength(3);
    expect(extensionFrames.map((entry) => entry.dir)).toEqual(["in", "in", "out"]);
    expect(recording.entries.filter((entry) => entry.event).map((entry) => entry.event)).toEqual([
      "generation_change",
      "process_spawn",
      "process_ready",
      "process_exit",
    ]);
  });

  it("redacts protected Bash commands and every correlated result without mutating RPC input", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recording-protected-"));
    roots.push(root);
    const recordingsDir = join(root, "recordings-root");
    const sessionCwd = join(root, "session", "workspace");
    const recorder = new RecorderManager({
      globalEnabled: true,
      recordingsDir,
      recordingsDirForSession: (sessionId) => join(recordingsDir, sessionId, "recordings"),
    });
    const observer = createPiRecordingObserver({
      recorder,
      recordingSessionId: ROOT_SESSION,
      cwd: sessionCwd,
    });
    const pi = runtime(ROOT_SESSION, observer);
    const protectedCommand = "user-space write documents/private.txt --content pi-command-secret";
    const protectedStart = {
      type: "tool_execution_start",
      toolCallId: "protected-tool-1",
      toolName: "bash",
      args: { command: protectedCommand, timeout: 30 },
    };
    const serializedStart = JSON.stringify(protectedStart);

    pi.stdout.write(`${serializedStart}\n`);
    pi.stdout.write(
      `${JSON.stringify({
        type: "message_update",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "protected-tool-1",
              name: "bash",
              arguments: { command: protectedCommand },
            },
          ],
        },
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "streamed-command-secret",
        },
      })}\n`,
    );
    recorder.record(
      ROOT_SESSION,
      "out",
      JSON.stringify({
        type: "message_delta",
        generation: 1,
        messageId: "assistant-protected-1",
        role: "assistant",
        delta: {
          kind: "tool_arguments",
          contentIndex: 0,
          delta: "browser-streamed-command-secret",
        },
        timestamp: 1,
      }),
      "browser",
      "pi",
      sessionCwd,
    );
    recorder.record(
      ROOT_SESSION,
      "out",
      JSON.stringify({
        type: "event_replay",
        events: [
          {
            seq: 1,
            message: {
              type: "message_delta",
              generation: 1,
              messageId: "assistant-protected-1",
              role: "assistant",
              delta: {
                kind: "tool_arguments",
                contentIndex: 0,
                delta: "replayed-command-secret",
              },
              timestamp: 1,
            },
          },
        ],
      }),
      "browser",
      "pi",
      sessionCwd,
    );
    pi.stdout.write(
      `${JSON.stringify({
        type: "tool_execution_update",
        toolCallId: "protected-tool-1",
        toolName: "bash",
        args: { command: protectedCommand },
        partialResult: {
          content: [{ type: "text", text: "pi-update-secret" }],
          details: { output: "pi-update-detail-secret" },
        },
      })}\n`,
    );
    pi.stdout.write(
      `${JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "protected-tool-1",
        toolName: "bash",
        result: {
          content: [{ type: "text", text: "pi-end-secret" }],
          details: { output: "pi-end-detail-secret" },
        },
        isError: false,
      })}\n`,
    );
    pi.stdout.write(
      `${JSON.stringify({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "protected-tool-1",
          content: [{ type: "text", text: "pi-message-secret" }],
          details: { output: "pi-message-detail-secret" },
          isError: false,
        },
      })}\n`,
    );
    pi.stdout.write(
      `${JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "protected-tool-1",
                name: "bash",
                arguments: { command: protectedCommand },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "protected-tool-1",
            toolName: "bash",
            content: [{ type: "text", text: "pi-agent-end-secret" }],
            details: { output: "pi-agent-end-detail-secret" },
            isError: false,
          },
        ],
        willRetry: false,
      })}\n`,
    );

    recorder.record(
      ROOT_SESSION,
      "out",
      JSON.stringify({
        type: "history_snapshot",
        generation: 1,
        entries: [
          {
            id: "history-tool-1",
            timestamp: 1,
            event: {
              type: "tool_execution",
              generation: 1,
              toolCallId: "protected-tool-1",
              toolName: "bash",
              status: "completed",
              timestamp: 1,
              output: "browser-history-secret",
            },
          },
        ],
        total: 1,
        cursor: 0,
        nextCursor: 1,
        hasMore: false,
        reason: "initial",
      }),
      "browser",
      "pi",
      sessionCwd,
    );

    const ordinaryPiDelta = JSON.stringify({
      type: "message_update",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "ordinary-tool-1",
            name: "bash",
            arguments: { command: "pwd" },
          },
        ],
      },
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "ordinary-pi-arguments-delta",
      },
    });
    pi.stdout.write(`${ordinaryPiDelta}\n`);
    recorder.record(
      ROOT_SESSION,
      "out",
      JSON.stringify({
        type: "message_delta",
        generation: 1,
        messageId: "assistant-ordinary-1",
        role: "assistant",
        delta: {
          kind: "tool_arguments",
          contentIndex: 0,
          delta: "ordinary-browser-arguments-delta",
        },
        timestamp: 2,
      }),
      "browser",
      "pi",
      sessionCwd,
    );
    pi.stdout.write(
      `${JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "ordinary-tool-1",
        toolName: "bash",
        args: { command: "pwd" },
      })}\n`,
    );
    pi.stdout.write(
      `${JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "ordinary-tool-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "ordinary-output" }] },
        isError: false,
      })}\n`,
    );

    const direct = pi.transport.request({
      id: "protected-rpc-bash-1",
      type: "bash",
      command: "onlyoffice operation --request direct-command-secret",
    });
    await eventually(() =>
      expect(pi.writes.some((raw) => raw.includes('"id":"protected-rpc-bash-1"'))).toBe(true),
    );
    pi.stdout.write(
      `${JSON.stringify({
        type: "bash_execution_update",
        id: "protected-rpc-bash-1",
        delta: "direct-update-secret",
      })}\n`,
    );
    pi.stdout.write(
      `${JSON.stringify({
        id: "protected-rpc-bash-1",
        type: "response",
        command: "bash",
        success: true,
        data: { output: "direct-result-secret", exitCode: 0 },
      })}\n`,
    );
    await expect(direct).resolves.toMatchObject({ success: true, command: "bash" });

    await eventually(() => {
      expect(recorder.getRecordingStatus(ROOT_SESSION).filePath).toBeDefined();
      expect(
        loadRecording(recorder.getRecordingStatus(ROOT_SESSION).filePath!).entries.length,
      ).toBeGreaterThanOrEqual(12);
    });
    pi.transport.dispose();
    const filePath = recorder.getRecordingStatus(ROOT_SESSION).filePath!;
    recorder.closeAll();

    // The observer receives immutable validated Pi frames. Sanitization happens
    // only on the copy written to the recording file.
    expect(serializedStart).toContain("pi-command-secret");

    const disk = readFileSync(filePath, "utf8");
    for (const secret of [
      "pi-command-secret",
      "streamed-command-secret",
      "browser-streamed-command-secret",
      "replayed-command-secret",
      "pi-update-secret",
      "pi-update-detail-secret",
      "pi-end-secret",
      "pi-end-detail-secret",
      "pi-message-secret",
      "pi-message-detail-secret",
      "pi-agent-end-secret",
      "pi-agent-end-detail-secret",
      "browser-history-secret",
      "direct-command-secret",
      "direct-update-secret",
      "direct-result-secret",
    ]) {
      expect(disk).not.toContain(secret);
    }
    expect(disk).toContain("ordinary-output");
    expect(disk).toContain("ordinary-pi-arguments-delta");
    expect(disk).toContain("ordinary-browser-arguments-delta");

    const recording = loadRecording(filePath);
    const frames = recording.entries
      .filter((entry) => !entry.event)
      .map((entry) => JSON.parse(entry.raw) as Record<string, unknown>);
    expect(
      frames.find(
        (frame) => frame.type === "tool_execution_start" && frame.toolCallId === "protected-tool-1",
      ),
    ).toMatchObject({
      type: "tool_execution_start",
      toolCallId: "protected-tool-1",
      toolName: "bash",
      args: { command: "[REDACTED]", timeout: 30 },
    });
    expect(
      frames.find(
        (frame) => frame.type === "tool_execution_end" && frame.toolCallId === "protected-tool-1",
      ),
    ).toMatchObject({
      type: "tool_execution_end",
      toolCallId: "protected-tool-1",
      toolName: "bash",
      result: { redacted: true },
      isError: false,
    });
    expect(
      frames.find((frame) => frame.type === "response" && frame.id === "protected-rpc-bash-1"),
    ).toMatchObject({
      type: "response",
      command: "bash",
      success: true,
      data: { redacted: true },
    });
    expect(
      frames.find(
        (frame) =>
          frame.type === "message_update" &&
          (frame.assistantMessageEvent as Record<string, unknown> | undefined)?.delta ===
            "ordinary-pi-arguments-delta",
      ),
    ).toEqual(JSON.parse(ordinaryPiDelta));
    expect(
      frames.find(
        (frame) =>
          frame.type === "message_delta" &&
          (frame.delta as Record<string, unknown> | undefined)?.delta ===
            "ordinary-browser-arguments-delta",
      ),
    ).toMatchObject({
      delta: {
        kind: "tool_arguments",
        delta: "ordinary-browser-arguments-delta",
      },
    });
    expect(frames.find((frame) => frame.type === "event_replay")).toMatchObject({
      events: [
        {
          message: {
            type: "message_delta",
            delta: {
              kind: "tool_arguments",
              delta: "[REDACTED]",
              _recordingRedaction: "uncorrelated_tool_arguments",
            },
          },
        },
      ],
    });
  });
});

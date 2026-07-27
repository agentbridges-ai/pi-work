import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  PiSessionHistoryError,
  readPiSessionDocument,
  readPiSessionDocumentSync,
  readPiSessionHistoryPage,
  restoredPiSessionState,
} from "./pi-session-history.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(newline = "\n") {
  const sessionDir = await mkdtemp(join(tmpdir(), "piwork-pi-history-"));
  roots.push(sessionDir);
  const store = join(sessionDir, "pi-sessions");
  await mkdir(store, { recursive: true });
  const file = join(store, "session.jsonl");
  const records = [
    {
      type: "session",
      version: 3,
      id: "pi-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: join(sessionDir, "workspace"),
    },
    {
      type: "model_change",
      id: "e1",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      provider: "p",
      modelId: "m",
    },
    {
      type: "custom",
      id: "e2",
      parentId: "e1",
      timestamp: "2026-01-01T00:00:02.000Z",
      customType: "piwork.todo",
      data: { text: "left right" },
    },
    {
      type: "message",
      id: "e3",
      parentId: "e2",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "user", content: "hello" },
    },
  ];
  await writeFile(
    file,
    `${records.map((record) => JSON.stringify(record)).join(newline)}${newline}`,
  );
  return {
    sessionDir,
    relativePath: "pi-sessions/session.jsonl",
    file,
    cwd: join(sessionDir, "workspace"),
  };
}

describe("Pi JSONL history", () => {
  it("parses pinned v3 JSONL and paginates directly by stable entry id", async () => {
    const value = await fixture();
    const first = await readPiSessionHistoryPage({
      sessionDir: value.sessionDir,
      piSessionRelativePath: value.relativePath,
      expectedPiSessionId: "pi-1",
      expectedCwd: value.cwd,
      limit: 2,
    });
    expect(first.entries.map((entry) => entry.id)).toEqual(["e1", "e2"]);
    expect(first).toMatchObject({
      nextCursor: "e2",
      hasMore: true,
      totalEntries: 3,
      piSessionRelativePath: "pi-sessions/session.jsonl",
    });
    const second = await readPiSessionHistoryPage({
      sessionDir: value.sessionDir,
      piSessionRelativePath: value.relativePath,
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.entries.map((entry) => entry.id)).toEqual(["e3"]);
    expect(second.hasMore).toBe(false);
  });

  it("preserves U+2028 as data in strictly LF-framed JSONL", async () => {
    const value = await fixture();
    const document = await readPiSessionDocument({
      sessionDir: value.sessionDir,
      piSessionRelativePath: value.relativePath,
    });
    expect((document.entries[1]!.data as { text: string }).text).toBe("left right");
  });

  it("rejects CRLF-framed JSONL", async () => {
    const value = await fixture("\r\n");
    await expect(
      readPiSessionDocument({
        sessionDir: value.sessionDir,
        piSessionRelativePath: value.relativePath,
      }),
    ).rejects.toMatchObject({ code: "invalid_schema" });
  });

  it("rejects traversal, absolute paths, symlinks, and non-jsonl files", async () => {
    const value = await fixture();
    for (const path of [
      "../session.jsonl",
      "/tmp/session.jsonl",
      "file.txt",
      "pi-sessions/nested/session.jsonl",
      "session.jsonl",
    ]) {
      await expect(
        readPiSessionDocument({
          sessionDir: value.sessionDir,
          piSessionRelativePath: path,
        }),
      ).rejects.toMatchObject({ code: "invalid_path" });
    }
    const link = join(value.sessionDir, "pi-sessions", "linked.jsonl");
    await symlink(value.file, link);
    await expect(
      readPiSessionDocument({
        sessionDir: value.sessionDir,
        piSessionRelativePath: "pi-sessions/linked.jsonl",
      }),
    ).rejects.toMatchObject({ code: "symlink_forbidden" });
  });

  it("rejects malformed headers, duplicate ids, and missing parents", async () => {
    const value = await fixture();
    await writeFile(value.file, '{"type":"session","version":2}\n');
    await expect(
      readPiSessionDocument({
        sessionDir: value.sessionDir,
        piSessionRelativePath: value.relativePath,
      }),
    ).rejects.toMatchObject({ code: "invalid_header" });

    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "pi",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: value.cwd,
    });
    const missing = JSON.stringify({
      type: "custom",
      id: "e1",
      parentId: "future",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "x",
    });
    await writeFile(value.file, `${header}\n${missing}\n`);
    await expect(
      readPiSessionDocument({
        sessionDir: value.sessionDir,
        piSessionRelativePath: value.relativePath,
      }),
    ).rejects.toMatchObject({ code: "invalid_schema" });
  });

  it("enforces line/file/entry/page limits and final LF", async () => {
    const value = await fixture();
    await expect(
      readPiSessionDocument({
        sessionDir: value.sessionDir,
        piSessionRelativePath: value.relativePath,
        limits: { maxFileBytes: 10 },
      }),
    ).rejects.toMatchObject({ code: "file_too_large" });
    await expect(
      readPiSessionDocument({
        sessionDir: value.sessionDir,
        piSessionRelativePath: value.relativePath,
        limits: { maxLineBytes: 10 },
      }),
    ).rejects.toMatchObject({ code: "line_too_large" });
    await expect(
      readPiSessionHistoryPage({
        sessionDir: value.sessionDir,
        piSessionRelativePath: value.relativePath,
        limit: 201,
      }),
    ).rejects.toThrow(/maxPageSize/);
    const content = await import("node:fs/promises").then((fs) => fs.readFile(value.file, "utf8"));
    await writeFile(value.file, content.slice(0, -1));
    await expect(
      readPiSessionDocument({
        sessionDir: value.sessionDir,
        piSessionRelativePath: value.relativePath,
      }),
    ).rejects.toBeInstanceOf(PiSessionHistoryError);
  });

  it("rejects unknown cursors without guessing a page", async () => {
    const value = await fixture();
    await expect(
      readPiSessionHistoryPage({
        sessionDir: value.sessionDir,
        piSessionRelativePath: value.relativePath,
        cursor: "missing",
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("uses the same strict validator for synchronous startup restoration", async () => {
    const value = await fixture();
    expect(
      readPiSessionDocumentSync({
        sessionDir: value.sessionDir,
        piSessionRelativePath: value.relativePath,
        expectedPiSessionId: "pi-1",
        expectedCwd: value.cwd,
      }),
    ).toEqual(
      await readPiSessionDocument({
        sessionDir: value.sessionDir,
        piSessionRelativePath: value.relativePath,
        expectedPiSessionId: "pi-1",
        expectedCwd: value.cwd,
      }),
    );
  });

  it("restores model, thinking and mode from only the active Pi branch", () => {
    const entries = [
      {
        type: "model_change" as const,
        id: "root",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        provider: "openai",
        modelId: "initial",
      },
      {
        type: "model_change" as const,
        id: "abandoned",
        parentId: "root",
        timestamp: "2026-01-01T00:00:02.000Z",
        provider: "wrong",
        modelId: "branch",
      },
      {
        type: "thinking_level_change" as const,
        id: "active-thinking",
        parentId: "root",
        timestamp: "2026-01-01T00:00:03.000Z",
        thinkingLevel: "xhigh",
      },
      {
        type: "custom" as const,
        id: "active-mode",
        parentId: "active-thinking",
        timestamp: "2026-01-01T00:00:04.000Z",
        customType: "piwork.mode",
        data: { mode: "plan" },
      },
      {
        type: "message" as const,
        id: "active-assistant",
        parentId: "active-mode",
        timestamp: "2026-01-01T00:00:05.000Z",
        message: {
          role: "assistant",
          provider: "local",
          model: "model-active",
          content: [],
        },
      },
    ];

    expect(restoredPiSessionState(entries)).toEqual({
      model: {
        key: "local/model-active",
        provider: "local",
        modelId: "model-active",
      },
      thinkingLevel: "xhigh",
      mode: "plan",
    });
  });
});

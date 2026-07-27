import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextScopedUserSpaceRuntime,
  UserSpaceRuntimeDisposedError,
  type UserSpaceRuntime,
} from "./user-space-runtime.js";
import type { IndexedWorkspaceList } from "./user-space-index.js";
import { runtimeContextCoordinator } from "./runtime-context.js";

function fakeRuntime(): UserSpaceRuntime {
  return {
    rebuild: vi.fn(async () => ({ fileCount: 0, entryCount: 0, lastIndexedAt: Date.now() })),
    addEntries: vi.fn(async () => undefined),
    removePath: vi.fn(async () => undefined),
    indexSubtree: vi.fn(async () => ({ fileCount: 0, entryCount: 0, lastIndexedAt: Date.now() })),
    clearIndex: vi.fn(async () => undefined),
    listDir: vi.fn(async () => ({ entries: [], hasMore: false })),
    searchPaths: vi.fn(async () => ({ entries: [], hasMore: false })),
    walkTree: vi.fn(async () => ({ entries: [], hasMore: false })),
    searchContent: vi.fn(async () => ({ matches: [], truncated: false })),
    drop: vi.fn(),
  };
}

afterEach(async () => {
  await runtimeContextCoordinator.dispose();
});

describe("ContextScopedUserSpaceRuntime", () => {
  it("drops the old worker on context commit and lazily recreates it", async () => {
    runtimeContextCoordinator.activate({ userId: "u1", agentId: "e1", sessionId: "s1" });
    const first = fakeRuntime();
    const second = fakeRuntime();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const runtime = new ContextScopedUserSpaceRuntime(factory);

    await runtime.rebuild();
    expect(factory).toHaveBeenCalledTimes(1);

    const candidate = runtimeContextCoordinator.prepare({
      userId: "u1",
      agentId: "e1",
      sessionId: "s2",
    });
    expect(candidate.commit()).toBe(true);
    expect(first.drop).toHaveBeenCalledTimes(1);

    await runtime.rebuild();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.rebuild).toHaveBeenCalledTimes(1);
  });

  it("automatically retries an in-flight request on the new context runtime", async () => {
    runtimeContextCoordinator.activate({ userId: "u1", agentId: "e1", sessionId: "s1" });
    let rejectFirst: ((error: unknown) => void) | undefined;
    const first = fakeRuntime();
    first.listDir = vi.fn(
      (): Promise<IndexedWorkspaceList> =>
        new Promise((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    first.drop = vi.fn(() => rejectFirst?.(new UserSpaceRuntimeDisposedError()));
    const second = fakeRuntime();
    second.listDir = vi.fn(async (): Promise<IndexedWorkspaceList> => ({
      entries: [
        {
          name: "README.md",
          path: "README.md",
          parentPath: "",
          kind: "file" as const,
          ext: "md",
          depth: 1,
          previewKind: "text" as const,
          hidden: false,
          contentIndexed: false,
        },
      ],
    }));
    const runtime = new ContextScopedUserSpaceRuntime(
      vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
    );

    const pending = runtime.listDir("", 80);
    const candidate = runtimeContextCoordinator.prepare({
      userId: "u1",
      agentId: "e1",
      sessionId: "s2",
    });
    expect(candidate.commit()).toBe(true);

    await expect(pending).resolves.toMatchObject({
      entries: [expect.objectContaining({ path: "README.md" })],
    });
    expect(first.drop).toHaveBeenCalledTimes(1);
    expect(second.listDir).toHaveBeenCalledTimes(1);
  });

  it("drops its active worker exactly once when permanently disposed", async () => {
    runtimeContextCoordinator.activate({ userId: "u1", agentId: "e1", sessionId: "s1" });
    const delegate = fakeRuntime();
    const runtime = new ContextScopedUserSpaceRuntime(() => delegate);
    await runtime.rebuild();

    runtime.drop();
    runtime.drop();

    expect(delegate.drop).toHaveBeenCalledTimes(1);
    await expect(runtime.rebuild()).rejects.toBeInstanceOf(UserSpaceRuntimeDisposedError);
  });
});

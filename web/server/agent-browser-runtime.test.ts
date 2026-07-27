import { describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reapStaleAgentBrowserSocketDirs,
  refreshAgentBrowserSocketLease,
} from "./agent-browser-runtime.js";

describe("agent-browser socket leases", () => {
  it("refuses to scan a socket root reached through a symbolic link", () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-agent-browser-root-"));
    const target = join(root, "target");
    const linkedRoot = join(root, "linked");
    mkdirSync(target);
    symlinkSync(target, linkedRoot);

    try {
      expect(() => reapStaleAgentBrowserSocketDirs({ root: linkedRoot })).toThrow(
        "must be a real directory",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reaps only expired directories with no live owner or native daemon", () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-agent-browser-reaper-"));
    const stale = join(root, "stale");
    const liveOwner = join(root, "live-owner");
    const liveNative = join(root, "live-native");
    const young = join(root, "young");
    const missingSessionRoot = join(root, "missing-session-root");
    const legacy = join(root, "legacy");
    for (const path of [stale, liveOwner, liveNative, young, missingSessionRoot, legacy]) {
      mkdirSync(path);
    }
    refreshAgentBrowserSocketLease(stale, "stale-session", "/sessions/stale", {
      now: 1_000,
      ownerPid: 11,
    });
    refreshAgentBrowserSocketLease(liveOwner, "owner-session", "/sessions/owner", {
      now: 1_000,
      ownerPid: 22,
    });
    refreshAgentBrowserSocketLease(liveNative, "native-session", "/sessions/native", {
      now: 1_000,
      ownerPid: 33,
    });
    writeFileSync(join(liveNative, "nex-native.pid"), "44\n");
    refreshAgentBrowserSocketLease(young, "young-session", root, {
      now: 9_900,
      ownerPid: 55,
    });
    refreshAgentBrowserSocketLease(
      missingSessionRoot,
      "deleted-session",
      join(root, "already-deleted"),
      { now: 9_900, ownerPid: 66 },
    );
    utimesSync(legacy, new Date(1_000), new Date(1_000));

    try {
      expect(
        reapStaleAgentBrowserSocketDirs({
          root,
          now: 10_000,
          staleAfterMs: 5_000,
          pidIsAlive: (pid) => pid === 22 || pid === 44,
        }),
      ).toBe(3);
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(legacy)).toBe(false);
      expect(existsSync(liveOwner)).toBe(true);
      expect(existsSync(liveNative)).toBe(true);
      expect(existsSync(young)).toBe(true);
      expect(existsSync(missingSessionRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

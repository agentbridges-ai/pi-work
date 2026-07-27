import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import type { PiModel, PiRpcSessionState } from "./pi-rpc-contract.js";
import type { PiRpcEntriesResult, PiRpcTransport } from "./pi-rpc-transport.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface PiExtensionReadyState {
  version: 1;
  mode: "agent" | "plan";
  mcp: PiReadinessMcpStatus[];
}

export interface PiReadinessMcpStatus {
  name: string;
  status: "connected" | "failed" | "disabled" | "connecting";
}

export interface PiReadinessOptions {
  transport: PiRpcTransport;
  expectedSessionFile?: string;
  /**
   * Exact entries parsed from the resume JSONL before the child starts.
   * Pi may append startup state, but it must replay this complete prefix.
   */
  expectedHistoryEntries?: readonly Record<string, unknown>[];
  expectedMode: "agent" | "plan";
  extensionReady: Promise<PiExtensionReadyState>;
  getMcpStatus(): Promise<PiReadinessMcpStatus[]>;
  timeoutMs?: number;
}

export interface PiReadinessResult {
  state: PiRpcSessionState;
  models: PiModel[];
  history: PiRpcEntriesResult;
  commands: Record<string, unknown>[];
  extension: PiExtensionReadyState;
  mcp: PiReadinessMcpStatus[];
}

export class PiReadinessError extends Error {
  readonly code:
    | "timeout"
    | "state_mismatch"
    | "models_unavailable"
    | "history_mismatch"
    | "extension_mismatch"
    | "mcp_unavailable";

  constructor(code: PiReadinessError["code"], message: string) {
    super(message);
    this.name = "PiReadinessError";
    this.code = code;
  }
}

function positiveTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new TypeError("Pi readiness timeout must be a positive safe integer.");
  }
  return timeout;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new PiReadinessError("timeout", "Native Pi readiness timed out.")),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

function commandNames(commands: readonly Record<string, unknown>[]): Set<string> {
  return new Set(
    commands.flatMap((command) => (typeof command.name === "string" ? [command.name] : [])),
  );
}

function verifyHistory(
  history: PiRpcEntriesResult,
  expected: readonly Record<string, unknown>[] | undefined,
): void {
  const ids = history.entries.map((entry) =>
    typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null,
  );
  if (
    ids.some((id) => id === null) ||
    new Set(ids).size !== ids.length ||
    history.leafId !== (ids.at(-1) ?? null)
  ) {
    throw new PiReadinessError(
      "history_mismatch",
      "Pi returned an invalid restored history snapshot.",
    );
  }
  if (
    expected &&
    (history.entries.length < expected.length ||
      expected.some((entry, index) => !isDeepStrictEqual(history.entries[index], entry)))
  ) {
    throw new PiReadinessError("history_mismatch", "Pi did not replay the exact resumed history.");
  }
}

async function verifySessionFile(expected: string, actual: string | undefined): Promise<void> {
  if (!actual) {
    throw new PiReadinessError("history_mismatch", "Pi did not restore the expected session file.");
  }
  let expectedReal: string;
  let actualReal: string;
  try {
    [expectedReal, actualReal] = await Promise.all([
      realpath(resolve(expected)),
      realpath(resolve(actual)),
    ]);
  } catch {
    throw new PiReadinessError(
      "history_mismatch",
      "Pi session file identity could not be verified.",
    );
  }
  if (expectedReal !== actualReal) {
    throw new PiReadinessError("history_mismatch", "Pi restored a different session file.");
  }
}

/**
 * A Pi child is not exposed to browsers until every runtime dependency has
 * completed: state, model catalog, exact history restore/replay, extension
 * mode/commands, and managed MCP connections.
 */
export async function waitForPiReadiness(options: PiReadinessOptions): Promise<PiReadinessResult> {
  const timeoutMs = positiveTimeout(options.timeoutMs);
  const requestOptions = { timeoutMs };
  const readiness = (async () => {
    const [state, models, history, commands, extension] = await Promise.all([
      options.transport.getState(requestOptions),
      options.transport.getAvailableModels(requestOptions),
      options.transport.replayHistory(undefined, requestOptions),
      options.transport.getCommands(requestOptions),
      options.extensionReady,
    ]);
    // The trusted extension publishes the authoritative managed-MCP set in its
    // ready event. Reading status before that event races against an empty
    // launcher snapshot and can permanently fail otherwise healthy sessions.
    const mcp = await options.getMcpStatus();
    if (state.sessionId !== options.transport.sessionId) {
      throw new PiReadinessError("state_mismatch", "Pi state belongs to a different session.");
    }
    if (options.expectedSessionFile) {
      await verifySessionFile(options.expectedSessionFile, state.sessionFile);
    }
    if (models.length === 0) {
      throw new PiReadinessError("models_unavailable", "Pi returned no effective models.");
    }
    verifyHistory(history, options.expectedHistoryEntries);
    if (
      extension.version !== 1 ||
      extension.mode !== options.expectedMode ||
      !commandNames(commands).has("piwork-plan")
    ) {
      throw new PiReadinessError("extension_mismatch", "Piwork trusted Pi extension is not ready.");
    }
    const statuses = new Map(mcp.map((server) => [server.name, server.status]));
    for (const expected of extension.mcp) {
      const status = statuses.get(expected.name);
      if (status !== expected.status || status === "failed") {
        throw new PiReadinessError(
          "mcp_unavailable",
          "Managed MCP readiness does not match extension state.",
        );
      }
    }
    if (mcp.some((server) => server.status === "connecting" || server.status === "failed")) {
      throw new PiReadinessError("mcp_unavailable", "Managed MCP is not ready.");
    }
    return { state, models, history, commands, extension, mcp };
  })();
  return withTimeout(readiness, timeoutMs);
}

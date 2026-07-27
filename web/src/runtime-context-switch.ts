import { api } from "./api.js";
import { gateOfficeContextSwitch } from "./office-context-gate.js";
import {
  isAbortError,
  runtimeContextCoordinator,
  type RuntimeContext,
  type RuntimeContextCandidate,
  type RuntimeContextInput,
} from "./runtime-context.js";

export interface RuntimeContextTransition {
  context: RuntimeContext;
  signal: AbortSignal;
  /** Runs the Office and activation gates without mutating the active context. */
  prepare(): Promise<boolean>;
  commit(apply: () => void): Promise<boolean>;
  cancel(): Promise<void>;
}

export interface RuntimeContextTransitionOptions {
  /** New sessions are already starting; existing targets should be activated. */
  activateSession?: boolean;
}

/**
 * Single candidate flow used by agent/session switching entry points.
 * Starting a newer transition aborts this one's HTTP work and prevents commit.
 */
export function beginRuntimeContextTransition(
  input: RuntimeContextInput,
  options: RuntimeContextTransitionOptions = {},
): RuntimeContextTransition {
  const candidate: RuntimeContextCandidate = runtimeContextCoordinator.prepare(input);
  let ready: Promise<boolean> | null = null;

  const prepare = (): Promise<boolean> => {
    if (ready) return ready;
    ready = (async () => {
      try {
        await gateOfficeContextSwitch(input);
        if (options.activateSession !== false && input.sessionId) {
          await api.activateSession(input.sessionId, {
            signal: candidate.scope.signal,
            contextEpoch: candidate.context.epoch,
          });
        }
        return candidate.isLatest();
      } catch (error) {
        if (isAbortError(error) || candidate.scope.signal.aborted) return false;
        throw error;
      }
    })();
    return ready;
  };

  return {
    context: candidate.context,
    signal: candidate.scope.signal,
    prepare,
    async commit(apply: () => void): Promise<boolean> {
      try {
        if (!(await prepare())) {
          await candidate.abort();
          return false;
        }
        return candidate.commit(apply);
      } catch (error) {
        await candidate.abort();
        throw error;
      }
    },
    cancel: () => candidate.abort(),
  };
}

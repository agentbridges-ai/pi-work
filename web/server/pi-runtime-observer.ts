import type { PiRpcInput, PiRpcOutput } from "./pi-rpc-contract.js";

export interface PiRuntimeObservationContext {
  sessionId: string;
  generation: number;
}

export interface PiRpcFrameObservation {
  direction: "in" | "out";
  /** One validated JSON object without its LF delimiter. */
  raw: string;
  value: PiRpcInput | PiRpcOutput;
}

export type PiRuntimeLifecycleObservation =
  | { type: "process_spawn"; meta?: Record<string, unknown> }
  | { type: "process_ready"; meta?: Record<string, unknown> }
  | { type: "process_exit"; meta?: Record<string, unknown> }
  | { type: "generation_change"; meta?: Record<string, unknown> }
  | { type: "transport_error"; meta?: Record<string, unknown> }
  | { type: "reconnect_attempt"; meta?: Record<string, unknown> }
  | { type: "reconnect_success"; meta?: Record<string, unknown> };

/**
 * Optional, best-effort observation boundary for one native Pi runtime.
 * Implementations must never be required for transport or process correctness.
 */
export interface PiRuntimeObserver {
  onFrame?(frame: PiRpcFrameObservation, context: PiRuntimeObservationContext): void;
  onLifecycle?(event: PiRuntimeLifecycleObservation, context: PiRuntimeObservationContext): void;
}

export function observePiRpcFrame(
  observer: PiRuntimeObserver | undefined,
  frame: PiRpcFrameObservation,
  context: PiRuntimeObservationContext,
): void {
  try {
    observer?.onFrame?.(frame, context);
  } catch {
    // Diagnostics are best effort and must never disrupt the Pi transport.
  }
}

export function observePiRuntimeLifecycle(
  observer: PiRuntimeObserver | undefined,
  event: PiRuntimeLifecycleObservation,
  context: PiRuntimeObservationContext,
): void {
  try {
    observer?.onLifecycle?.(event, context);
  } catch {
    // Diagnostics are best effort and must never disrupt the Pi runtime.
  }
}

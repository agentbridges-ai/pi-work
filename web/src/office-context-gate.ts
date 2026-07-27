import type { RuntimeContextInput } from "./runtime-context.js";

export type OfficeContextGate = (next: RuntimeContextInput) => Promise<void>;

let activeGate: OfficeContextGate | null = null;

/**
 * Keeps the workbench shell independent from the heavy Office runtime.
 * The Office adapter registers this gate only after an Office preview is opened.
 */
export function registerOfficeContextGate(gate: OfficeContextGate): () => void {
  activeGate = gate;
  return () => {
    if (activeGate === gate) activeGate = null;
  };
}

export function gateOfficeContextSwitch(next: RuntimeContextInput): Promise<void> {
  return activeGate?.(next) ?? Promise.resolve();
}

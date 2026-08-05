import type { PiBootstrapPayload } from "./pi-bootstrap-channel.js";
import type { PiRpcTransportLike } from "./pi-rpc-transport.js";
import type { PiReadinessResult } from "./pi-readiness.js";
import type { PiLaunchOptions, PiSessionInfo } from "./pi-launcher.js";

/**
 * Lifecycle contract shared by the in-process native backend and the Unix
 * socket Runtime backend. Product code must not depend on how Node/Pi is
 * hosted or how a session process is stopped.
 */
export interface PiRuntimeBackend {
  nextLaunchGeneration(sessionId: string): number;
  launch(options: PiLaunchOptions): Promise<PiSessionInfo>;
  getSession(sessionId: string): PiSessionInfo | undefined;
  getTransport(sessionId: string): PiRpcTransportLike | undefined;
  getReadiness(sessionId: string): PiReadinessResult | undefined;
  getSandboxedGeneration(sessionId: string): number | undefined;
  validateLaunchGeneration(sessionId: string, generation: number): boolean;
  isAlive(sessionId: string): boolean;
  restoreSession(info: PiSessionInfo): void;
  listSessions(): PiSessionInfo[];
  kill(sessionId: string): Promise<boolean>;
  killAll(options?: { shutdown?: boolean }): Promise<void>;
  relaunch(sessionId: string, bootstrapPayload?: PiBootstrapPayload): Promise<PiSessionInfo>;
  setArchived(sessionId: string, archived: boolean): void;
  removeSession(sessionId: string): void;
}

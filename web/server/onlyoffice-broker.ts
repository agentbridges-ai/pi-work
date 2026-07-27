import type { ServerWebSocket } from "bun";
import type { Hono } from "hono";
import type { BrowserIncomingMessage } from "./session-types.js";
import type { SocketData } from "./ws-bridge-types.js";
import type { UserSpaceBroker } from "./user-space-broker.js";
import {
  isOnlyOfficeWriteOperation,
  parseOnlyOfficeOperation,
  type OnlyOfficeBrowserStatus,
  type OnlyOfficeDocumentDescriptor,
  type OnlyOfficeOperationTarget,
} from "../shared/onlyoffice.js";

const REQUEST_TIMEOUT_MS = 60_000;
const COMPLETED_REQUEST_LIMIT = 512;

type BrowserSocket = ServerWebSocket<SocketData>;
type BrowserLease = {
  socket: BrowserSocket;
  document: OnlyOfficeDocumentDescriptor | null;
  updatedAt: number;
};
type SettledResult = { ok: true; result: unknown } | { ok: false; error: string };
type PendingRequest = {
  socket: BrowserSocket;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class OnlyOfficeBrokerError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "OnlyOfficeBrokerError";
    this.retryable = retryable;
  }
}

export class OnlyOfficeBroker {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly completed = new Map<string, SettledResult>();
  private readonly browserLeases = new Map<string, Map<BrowserSocket, BrowserLease>>();
  private sender: ((socket: BrowserSocket, message: BrowserIncomingMessage) => void) | null = null;

  setSender(sender: (socket: BrowserSocket, message: BrowserIncomingMessage) => void): void {
    this.sender = sender;
  }

  updateStatus(sessionId: string, status: OnlyOfficeBrowserStatus, socket: BrowserSocket): void {
    let leases = this.browserLeases.get(sessionId);
    if (!leases) {
      leases = new Map();
      this.browserLeases.set(sessionId, leases);
    }
    leases.set(socket, { socket, document: status.document, updatedAt: Date.now() });
  }

  removeSocket(sessionId: string, socket: BrowserSocket): void {
    const leases = this.browserLeases.get(sessionId);
    leases?.delete(socket);
    if (leases?.size === 0) this.browserLeases.delete(sessionId);
    for (const [key, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.reject(new OnlyOfficeBrokerError("The assigned browser disconnected.", true));
    }
  }

  getActiveDocument(sessionId: string): OnlyOfficeDocumentDescriptor | null {
    return this.selectLease(sessionId, undefined, true)?.document ?? null;
  }

  /**
   * The Agent-facing endpoint intentionally omits browser-internal routing
   * identifiers. The browser bridge still receives the complete descriptor
   * through the session WebSocket.
   */
  getActiveDocumentForAgent(
    sessionId: string,
  ): Omit<OnlyOfficeDocumentDescriptor, "mountId"> | null {
    const document = this.getActiveDocument(sessionId);
    if (!document) return null;
    const { mountId: _mountId, ...publicDocument } = document;
    return publicDocument;
  }

  /**
   * Drain requests that crossed authentication before the runtime capability
   * was revoked. This is called before a replacement Pi generation is
   * admitted, so a late browser save cannot commit after relaunch/kill.
   */
  async revokeRuntimeGeneration(sessionId: string): Promise<void> {
    const pending = [...this.pending.entries()]
      .filter(([key]) => key.startsWith(`${sessionId}\0`))
      .map(([, request]) => request.promise);
    await Promise.allSettled(pending);
  }

  async requestOperation(
    sessionId: string,
    requestId: string,
    operationInput: unknown,
    target?: OnlyOfficeOperationTarget,
  ): Promise<unknown> {
    if (!requestId || requestId.length > 200) {
      throw new OnlyOfficeBrokerError("A valid request_id is required.", false);
    }
    const key = `${sessionId}\0${requestId}`;
    const settled = this.completed.get(key);
    if (settled) {
      if (settled.ok) return settled.result;
      throw new OnlyOfficeBrokerError(settled.error, false);
    }
    const existing = this.pending.get(key);
    if (existing) return existing.promise;

    const operation = parseOnlyOfficeOperation(operationInput);
    const lease = this.selectLease(sessionId, target, !target);
    if (!lease) {
      throw new OnlyOfficeBrokerError(
        target
          ? "No connected browser is available to open the requested Office file."
          : "No active ONLYOFFICE document is open in this conversation.",
        true,
      );
    }
    const active = lease.document;
    if (!target && active) {
      if (!active.pluginReady) {
        throw new OnlyOfficeBrokerError("The ONLYOFFICE plugin bridge is still starting.", true);
      }
      if (!active.writable && isOnlyOfficeWriteOperation(operation)) {
        throw new OnlyOfficeBrokerError("The active document is read-only.", false);
      }
    }
    if (!this.sender) {
      throw new OnlyOfficeBrokerError("The ONLYOFFICE browser bridge is unavailable.", true);
    }

    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    const timer = setTimeout(() => {
      this.pending.delete(key);
      reject(new OnlyOfficeBrokerError("ONLYOFFICE operation timed out.", true));
    }, REQUEST_TIMEOUT_MS);
    this.pending.set(key, { socket: lease.socket, promise, resolve, reject, timer });
    this.sender(lease.socket, {
      type: "onlyoffice_request",
      request_id: requestId,
      lease_id: target ? undefined : active?.leaseId,
      editor_instance_id: target ? undefined : active?.editorInstanceId,
      target,
      operation,
    });
    return promise;
  }

  resolveResponse(
    sessionId: string,
    requestId: string,
    socket: BrowserSocket,
    ok: boolean,
    result?: unknown,
    error?: string,
  ): void {
    const key = `${sessionId}\0${requestId}`;
    const pending = this.pending.get(key);
    if (!pending || pending.socket !== socket) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    const settled: SettledResult = ok
      ? { ok: true, result }
      : { ok: false, error: error || "ONLYOFFICE operation failed." };
    this.rememberCompleted(key, settled);
    if (settled.ok) pending.resolve(settled.result);
    else pending.reject(new OnlyOfficeBrokerError(settled.error, false));
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new OnlyOfficeBrokerError("ONLYOFFICE bridge was disposed.", true));
    }
    this.pending.clear();
    this.completed.clear();
    this.browserLeases.clear();
  }

  private selectLease(
    sessionId: string,
    target: OnlyOfficeOperationTarget | undefined,
    requireActive: boolean,
  ): BrowserLease | null {
    const leases = [...(this.browserLeases.get(sessionId)?.values() ?? [])];
    const exactTarget = target
      ? leases.filter(
          (lease) =>
            lease.document?.mountId === target.mountId && lease.document?.path === target.path,
        )
      : [];
    const matching =
      exactTarget.length > 0
        ? exactTarget
        : leases.filter((lease) => (requireActive ? Boolean(lease.document) : true));
    return (
      matching.sort((left, right) => {
        const foreground = Number(right.document?.foreground) - Number(left.document?.foreground);
        return foreground || right.updatedAt - left.updatedAt;
      })[0] ?? null
    );
  }

  private rememberCompleted(key: string, result: SettledResult): void {
    this.completed.set(key, result);
    while (this.completed.size > COMPLETED_REQUEST_LIMIT) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completed.delete(oldest);
    }
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export function registerOnlyOfficeInternalRoutes(
  app: Hono,
  broker: OnlyOfficeBroker,
  userSpaceBroker: UserSpaceBroker,
): void {
  app.use("/internal/onlyoffice/:sessionId/*", async (c, next) => {
    const token =
      (c.req.header("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
    if (!userSpaceBroker.validateInternalCapability(c.req.param("sessionId"), token)) {
      return c.json({ error: "Invalid or expired ONLYOFFICE capability." }, 401);
    }
    await next();
  });

  app.get("/internal/onlyoffice/:sessionId/active", (c) => {
    return c.json({ document: broker.getActiveDocumentForAgent(c.req.param("sessionId")) });
  });

  app.post("/internal/onlyoffice/:sessionId/operation", async (c) => {
    try {
      const body = await readJsonBody(c.req.raw);
      if (body.target !== undefined) {
        throw new OnlyOfficeBrokerError(
          "ONLYOFFICE target routing is internal-only; open and focus the intended file first.",
          false,
        );
      }
      const result = await broker.requestOperation(
        c.req.param("sessionId"),
        typeof body.request_id === "string" ? body.request_id : "",
        body.operation,
      );
      return c.json({ ok: true, result });
    } catch (error) {
      const retryable = error instanceof OnlyOfficeBrokerError && error.retryable;
      return c.json(
        {
          ok: false,
          retryable,
          error: error instanceof Error ? error.message : String(error),
          document: broker.getActiveDocumentForAgent(c.req.param("sessionId")),
        },
        retryable ? 503 : 400,
      );
    }
  });
}

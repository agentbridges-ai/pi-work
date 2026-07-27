export interface WsRuntimeContextIdentity {
  epoch: number;
  contextId: string;
}

/** Owns browser socket identity, exact runtime context, and scope cleanup as one unit. */
export class WsConnectionRegistry {
  private readonly sockets = new Map<string, WebSocket>();
  private readonly contexts = new Map<string, WsRuntimeContextIdentity>();
  private readonly scopeDetachers = new Map<string, () => void>();

  get(sessionId: string): WebSocket | undefined {
    return this.sockets.get(sessionId);
  }

  epoch(sessionId: string): number | undefined {
    return this.contexts.get(sessionId)?.epoch;
  }

  context(sessionId: string): WsRuntimeContextIdentity | undefined {
    return this.contexts.get(sessionId);
  }

  isCurrent(sessionId: string, socket: WebSocket): boolean {
    return this.sockets.get(sessionId) === socket;
  }

  attach(sessionId: string, socket: WebSocket, context?: WsRuntimeContextIdentity): void {
    this.remove(sessionId);
    this.sockets.set(sessionId, socket);
    if (context) this.contexts.set(sessionId, context);
  }

  attachScope(sessionId: string, detach: () => void): void {
    this.scopeDetachers.get(sessionId)?.();
    this.scopeDetachers.set(sessionId, detach);
  }

  remove(sessionId: string, expectedSocket?: WebSocket): boolean {
    if (expectedSocket && this.sockets.get(sessionId) !== expectedSocket) return false;
    this.sockets.delete(sessionId);
    this.contexts.delete(sessionId);
    const detach = this.scopeDetachers.get(sessionId);
    this.scopeDetachers.delete(sessionId);
    detach?.();
    return true;
  }

  sessionIds(): IterableIterator<string> {
    return this.sockets.keys();
  }
}

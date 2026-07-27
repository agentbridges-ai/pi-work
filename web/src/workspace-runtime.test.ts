import { describe, expect, it } from "vitest";
import { initialWorkspaceRuntimeState, workspaceRuntimeReducer } from "./workspace-runtime.js";

describe("workspaceRuntimeReducer", () => {
  it("tracks auth, local runtime, workspace, and connection states", () => {
    let state = workspaceRuntimeReducer(initialWorkspaceRuntimeState, {
      type: "authAuthenticated",
    });
    state = workspaceRuntimeReducer(state, { type: "runtimeEnsuring", operationId: 1 });
    state = workspaceRuntimeReducer(state, { type: "runtimeReady", operationId: 1 });
    state = workspaceRuntimeReducer(state, { type: "workspaceLoadingSnapshot", operationId: 2 });
    state = workspaceRuntimeReducer(state, { type: "workspaceSnapshotLoaded", operationId: 2 });
    state = workspaceRuntimeReducer(state, { type: "connectionConnecting", operationId: 3 });
    state = workspaceRuntimeReducer(state, { type: "connectionConnected", operationId: 3 });

    expect(state).toMatchObject({
      auth: "authenticated",
      runtime: "ready",
      workspace: "ready",
      connection: "connected",
      operationId: 3,
      error: null,
    });
  });

  it("ignores stale operation completions", () => {
    let state = workspaceRuntimeReducer(initialWorkspaceRuntimeState, {
      type: "workspaceLoadingSnapshot",
      operationId: 10,
    });
    state = workspaceRuntimeReducer(state, {
      type: "workspaceError",
      operationId: 9,
      error: "stale",
    });
    state = workspaceRuntimeReducer(state, { type: "workspaceSnapshotLoaded", operationId: 9 });

    expect(state.workspace).toBe("loadingSnapshot");
    expect(state.error).toBeNull();
  });

  it("resets on logout", () => {
    const active = workspaceRuntimeReducer(initialWorkspaceRuntimeState, {
      type: "authAuthenticated",
    });
    const reset = workspaceRuntimeReducer(active, { type: "logoutReset" });

    expect(reset.auth).toBe("unauthenticated");
    expect(reset.workspace).toBe("loadingSnapshot");
    expect(reset.connection).toBe("disconnected");
  });
});

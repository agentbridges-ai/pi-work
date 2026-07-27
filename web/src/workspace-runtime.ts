export type AuthRuntimeState = "checking" | "unauthenticated" | "authenticated";
export type LocalRuntimeState = "idle" | "ensuring" | "ready" | "error";
export type WorkspaceRuntimeStateName =
  "loadingSnapshot" | "ready" | "switching" | "creatingSession" | "error";
export type ConnectionRuntimeState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface WorkspaceRuntimeState {
  auth: AuthRuntimeState;
  runtime: LocalRuntimeState;
  workspace: WorkspaceRuntimeStateName;
  connection: ConnectionRuntimeState;
  operationId: number;
  error: string | null;
}

export type WorkspaceRuntimeAction =
  | { type: "authChecking" }
  | { type: "authAuthenticated" }
  | { type: "authUnauthenticated" }
  | { type: "runtimeEnsuring"; operationId: number }
  | { type: "runtimeReady"; operationId: number }
  | { type: "runtimeError"; operationId: number; error: string }
  | { type: "workspaceLoadingSnapshot"; operationId: number }
  | { type: "workspaceSnapshotLoaded"; operationId: number }
  | { type: "workspaceSwitching"; operationId: number }
  | { type: "workspaceCreatingSession"; operationId: number }
  | { type: "workspaceError"; operationId: number; error: string }
  | { type: "connectionConnecting"; operationId: number }
  | { type: "connectionConnected"; operationId: number }
  | { type: "connectionReconnecting"; operationId: number }
  | { type: "connectionDisconnected"; operationId: number }
  | { type: "logoutReset" };

export const initialWorkspaceRuntimeState: WorkspaceRuntimeState = {
  auth: "checking",
  runtime: "idle",
  workspace: "loadingSnapshot",
  connection: "disconnected",
  operationId: 0,
  error: null,
};

function stale(state: WorkspaceRuntimeState, operationId: number): boolean {
  return operationId < state.operationId;
}

export function workspaceRuntimeReducer(
  state: WorkspaceRuntimeState,
  action: WorkspaceRuntimeAction,
): WorkspaceRuntimeState {
  switch (action.type) {
    case "authChecking":
      return { ...state, auth: "checking", error: null };
    case "authAuthenticated":
      return { ...state, auth: "authenticated", error: null };
    case "authUnauthenticated":
      return { ...initialWorkspaceRuntimeState, auth: "unauthenticated" };
    case "runtimeEnsuring":
      return { ...state, runtime: "ensuring", operationId: action.operationId, error: null };
    case "runtimeReady":
      if (stale(state, action.operationId)) return state;
      return { ...state, runtime: "ready", error: null };
    case "runtimeError":
      if (stale(state, action.operationId)) return state;
      return { ...state, runtime: "error", error: action.error };
    case "workspaceLoadingSnapshot":
      return {
        ...state,
        workspace: "loadingSnapshot",
        operationId: action.operationId,
        error: null,
      };
    case "workspaceSnapshotLoaded":
      if (stale(state, action.operationId)) return state;
      return { ...state, workspace: "ready", error: null };
    case "workspaceSwitching":
      return { ...state, workspace: "switching", operationId: action.operationId, error: null };
    case "workspaceCreatingSession":
      return {
        ...state,
        workspace: "creatingSession",
        operationId: action.operationId,
        error: null,
      };
    case "workspaceError":
      if (stale(state, action.operationId)) return state;
      return { ...state, workspace: "error", error: action.error };
    case "connectionConnecting":
      return { ...state, connection: "connecting", operationId: action.operationId };
    case "connectionConnected":
      if (stale(state, action.operationId)) return state;
      return { ...state, connection: "connected" };
    case "connectionReconnecting":
      return { ...state, connection: "reconnecting", operationId: action.operationId };
    case "connectionDisconnected":
      if (stale(state, action.operationId)) return state;
      return { ...state, connection: "disconnected" };
    case "logoutReset":
      return { ...initialWorkspaceRuntimeState, auth: "unauthenticated" };
    default:
      return state;
  }
}

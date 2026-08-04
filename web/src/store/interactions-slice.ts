import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { CompletedInteraction, InteractionRequest, InteractionResponse } from "../types.js";

const MAX_COMPLETED_INTERACTIONS_PER_SESSION = 50;

export interface InteractionsSlice {
  pendingInteractions: Map<string, Map<string, InteractionRequest>>;
  completedInteractions: Map<string, CompletedInteraction[]>;
  addInteraction: (sessionId: string, request: InteractionRequest) => void;
  removeInteraction: (sessionId: string, requestId: string) => void;
  completeInteraction: (
    sessionId: string,
    response: InteractionResponse,
    timestamp?: number,
  ) => void;
  replacePendingInteractions: (sessionId: string, requests: InteractionRequest[]) => void;
  clearPendingInteractions: (sessionId: string) => void;
  clearCompletedInteractions: (sessionId: string) => void;
}

export const createInteractionsSlice: StateCreator<AppState, [], [], InteractionsSlice> = (
  set,
) => ({
  pendingInteractions: new Map(),
  completedInteractions: new Map(),
  addInteraction: (sessionId, request) =>
    set((state) => {
      const pendingInteractions = new Map(state.pendingInteractions);
      const requests = new Map(pendingInteractions.get(sessionId) || []);
      requests.set(request.id, request);
      pendingInteractions.set(sessionId, requests);
      return { pendingInteractions };
    }),
  removeInteraction: (sessionId, requestId) =>
    set((state) => {
      const pendingInteractions = new Map(state.pendingInteractions);
      const current = pendingInteractions.get(sessionId);
      if (!current) return { pendingInteractions };
      const next = new Map(current);
      next.delete(requestId);
      if (next.size === 0) pendingInteractions.delete(sessionId);
      else pendingInteractions.set(sessionId, next);
      return { pendingInteractions };
    }),
  completeInteraction: (sessionId, response, timestamp = Date.now()) =>
    set((state) => {
      const request = state.pendingInteractions.get(sessionId)?.get(response.requestId);
      if (!request) return {};
      const pendingInteractions = new Map(state.pendingInteractions);
      const requests = new Map(pendingInteractions.get(sessionId) || []);
      requests.delete(response.requestId);
      if (requests.size === 0) pendingInteractions.delete(sessionId);
      else pendingInteractions.set(sessionId, requests);
      const completedInteractions = new Map(state.completedInteractions);
      completedInteractions.set(
        sessionId,
        [...(completedInteractions.get(sessionId) || []), { request, response, timestamp }].slice(
          -MAX_COMPLETED_INTERACTIONS_PER_SESSION,
        ),
      );
      return { pendingInteractions, completedInteractions };
    }),
  replacePendingInteractions: (sessionId, requests) =>
    set((state) => {
      const pendingInteractions = new Map(state.pendingInteractions);
      if (requests.length === 0) pendingInteractions.delete(sessionId);
      else
        pendingInteractions.set(
          sessionId,
          new Map(requests.map((request) => [request.id, request])),
        );
      return { pendingInteractions };
    }),
  clearPendingInteractions: (sessionId) =>
    set((state) => {
      const pendingInteractions = new Map(state.pendingInteractions);
      pendingInteractions.delete(sessionId);
      return { pendingInteractions };
    }),
  clearCompletedInteractions: (sessionId) =>
    set((state) => {
      const completedInteractions = new Map(state.completedInteractions);
      completedInteractions.delete(sessionId);
      return { completedInteractions };
    }),
});

import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { CompletedInteraction, InteractionRequest, InteractionResponse } from "../types.js";

const MAX_COMPLETED_INTERACTIONS_PER_SESSION = 50;

export interface InteractionSubmission {
  clientMsgId: string;
  generation: number;
  submittedAt: number;
}

export interface InteractionsSlice {
  pendingInteractions: Map<string, Map<string, InteractionRequest>>;
  interactionSubmissions: Map<string, Map<string, InteractionSubmission>>;
  completedInteractions: Map<string, CompletedInteraction[]>;
  addInteraction: (sessionId: string, request: InteractionRequest) => void;
  removeInteraction: (sessionId: string, requestId: string) => void;
  completeInteraction: (
    sessionId: string,
    response: InteractionResponse,
    timestamp?: number,
  ) => void;
  markInteractionSubmitting: (
    sessionId: string,
    requestId: string,
    submission: InteractionSubmission,
  ) => void;
  clearInteractionSubmission: (sessionId: string, requestId?: string) => void;
  clearPendingInteractions: (sessionId: string) => void;
  clearCompletedInteractions: (sessionId: string) => void;
}

export const createInteractionsSlice: StateCreator<AppState, [], [], InteractionsSlice> = (
  set,
) => ({
  pendingInteractions: new Map(),
  interactionSubmissions: new Map(),
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
      if (current) {
        const next = new Map(current);
        next.delete(requestId);
        if (next.size === 0) pendingInteractions.delete(sessionId);
        else pendingInteractions.set(sessionId, next);
      }
      const interactionSubmissions = new Map(state.interactionSubmissions);
      const submissions = interactionSubmissions.get(sessionId);
      if (submissions) {
        const nextSubmissions = new Map(submissions);
        nextSubmissions.delete(requestId);
        if (nextSubmissions.size === 0) interactionSubmissions.delete(sessionId);
        else interactionSubmissions.set(sessionId, nextSubmissions);
      }
      return { pendingInteractions, interactionSubmissions };
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
      const interactionSubmissions = new Map(state.interactionSubmissions);
      const submissions = interactionSubmissions.get(sessionId);
      if (submissions) {
        const nextSubmissions = new Map(submissions);
        nextSubmissions.delete(response.requestId);
        if (nextSubmissions.size === 0) interactionSubmissions.delete(sessionId);
        else interactionSubmissions.set(sessionId, nextSubmissions);
      }
      completedInteractions.set(
        sessionId,
        [...(completedInteractions.get(sessionId) || []), { request, response, timestamp }].slice(
          -MAX_COMPLETED_INTERACTIONS_PER_SESSION,
        ),
      );
      return { pendingInteractions, completedInteractions, interactionSubmissions };
    }),
  markInteractionSubmitting: (sessionId, requestId, submission) =>
    set((state) => {
      const interactionSubmissions = new Map(state.interactionSubmissions);
      const submissions = new Map(interactionSubmissions.get(sessionId) || []);
      submissions.set(requestId, submission);
      interactionSubmissions.set(sessionId, submissions);
      return { interactionSubmissions };
    }),
  clearInteractionSubmission: (sessionId, requestId) =>
    set((state) => {
      const interactionSubmissions = new Map(state.interactionSubmissions);
      if (!requestId) interactionSubmissions.delete(sessionId);
      else {
        const submissions = interactionSubmissions.get(sessionId);
        if (submissions) {
          const nextSubmissions = new Map(submissions);
          nextSubmissions.delete(requestId);
          if (nextSubmissions.size === 0) interactionSubmissions.delete(sessionId);
          else interactionSubmissions.set(sessionId, nextSubmissions);
        }
      }
      return { interactionSubmissions };
    }),
  clearPendingInteractions: (sessionId) =>
    set((state) => {
      const pendingInteractions = new Map(state.pendingInteractions);
      pendingInteractions.delete(sessionId);
      const interactionSubmissions = new Map(state.interactionSubmissions);
      interactionSubmissions.delete(sessionId);
      return { pendingInteractions, interactionSubmissions };
    }),
  clearCompletedInteractions: (sessionId) =>
    set((state) => {
      const completedInteractions = new Map(state.completedInteractions);
      completedInteractions.delete(sessionId);
      return { completedInteractions };
    }),
});

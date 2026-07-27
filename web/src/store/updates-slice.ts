import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { CreationProgressEvent } from "../types.js";

export interface UpdatesSlice {
  creationProgress: CreationProgressEvent[] | null;
  creationError: string | null;
  sessionCreating: boolean;
  sessionCreatingBackend: "pi" | null;

  addCreationProgress: (step: CreationProgressEvent) => void;
  clearCreation: () => void;
  setSessionCreating: (creating: boolean, backend?: "pi") => void;
  setCreationError: (error: string | null) => void;
}

export const createUpdatesSlice: StateCreator<AppState, [], [], UpdatesSlice> = (set) => ({
  creationProgress: null,
  creationError: null,
  sessionCreating: false,
  sessionCreatingBackend: null,

  addCreationProgress: (step) =>
    set((state) => {
      const existing = state.creationProgress || [];
      const idx = existing.findIndex((s) => s.step === step.step);
      if (idx >= 0) {
        const updated = [...existing];
        updated[idx] = step;
        return { creationProgress: updated };
      }
      return { creationProgress: [...existing, step] };
    }),
  clearCreation: () =>
    set({
      creationProgress: null,
      creationError: null,
      sessionCreating: false,
      sessionCreatingBackend: null,
    }),
  setSessionCreating: (creating, backend) =>
    set({ sessionCreating: creating, sessionCreatingBackend: backend ?? null }),
  setCreationError: (error) => set({ creationError: error }),
});

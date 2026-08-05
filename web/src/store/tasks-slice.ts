import type { StateCreator } from "zustand";
import type { AppState } from "./index.js";
import type { ProcessItem, TaskItem, ToolExecutionStatus } from "../types.js";

const MAX_TOOL_ACTIVITY_PER_SESSION = 2_000;

export interface ToolActivityEntry {
  toolCallId: string;
  toolName: string;
  status: ToolExecutionStatus;
  preview: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  startedAt: number;
  completedAt?: number;
  elapsedSeconds: number;
  parentToolCallId?: string;
}

export interface TasksSlice {
  sessionTasks: Map<string, TaskItem[]>;
  sessionProcesses: Map<string, ProcessItem[]>;
  toolProgress: Map<
    string,
    Map<string, { toolName: string; elapsedSeconds: number; text?: string }>
  >;
  toolActivity: Map<string, ToolActivityEntry[]>;
  setTasks: (sessionId: string, tasks: TaskItem[]) => void;
  setProcesses: (sessionId: string, processes: ProcessItem[]) => void;
  upsertProcess: (sessionId: string, process: ProcessItem) => void;
  updateProcess: (sessionId: string, taskId: string, updates: Partial<ProcessItem>) => void;
  setToolProgress: (
    sessionId: string,
    toolCallId: string,
    data: { toolName: string; elapsedSeconds: number; text?: string },
  ) => void;
  clearToolProgress: (sessionId: string, toolCallId?: string) => void;
  setToolActivity: (sessionId: string, entries: ToolActivityEntry[]) => void;
  upsertToolActivity: (sessionId: string, entry: ToolActivityEntry) => void;
  updateToolActivity: (
    sessionId: string,
    toolCallId: string,
    updates: Partial<ToolActivityEntry>,
  ) => void;
}

export const createTasksSlice: StateCreator<AppState, [], [], TasksSlice> = (set) => ({
  sessionTasks: new Map(),
  sessionProcesses: new Map(),
  toolProgress: new Map(),
  toolActivity: new Map(),
  setTasks: (sessionId, tasks) =>
    set((state) => {
      const sessionTasks = new Map(state.sessionTasks);
      sessionTasks.set(sessionId, tasks);
      return { sessionTasks };
    }),
  setProcesses: (sessionId, processes) =>
    set((state) => {
      const sessionProcesses = new Map(state.sessionProcesses);
      if (processes.length === 0) sessionProcesses.delete(sessionId);
      else sessionProcesses.set(sessionId, processes);
      return { sessionProcesses };
    }),
  upsertProcess: (sessionId, process) =>
    set((state) => {
      const sessionProcesses = new Map(state.sessionProcesses);
      const entries = [...(sessionProcesses.get(sessionId) || [])];
      const index = entries.findIndex((entry) => entry.taskId === process.taskId);
      if (index >= 0) {
        const current = entries[index];
        entries[index] = {
          ...current,
          ...process,
          toolCallId: current.toolCallId || process.toolCallId,
          originatingToolCallId: process.originatingToolCallId ?? current.originatingToolCallId,
          startedAt: current.startedAt,
          durationMs: Math.max(current.durationMs || 0, process.durationMs || 0),
        };
      } else entries.push(process);
      sessionProcesses.set(sessionId, entries);
      return { sessionProcesses };
    }),
  updateProcess: (sessionId, taskId, updates) =>
    set((state) => {
      const sessionProcesses = new Map(state.sessionProcesses);
      const entries = sessionProcesses.get(sessionId);
      if (entries) {
        sessionProcesses.set(
          sessionId,
          entries.map((entry) => (entry.taskId === taskId ? { ...entry, ...updates } : entry)),
        );
      }
      return { sessionProcesses };
    }),
  setToolProgress: (sessionId, toolCallId, data) =>
    set((state) => {
      const toolProgress = new Map(state.toolProgress);
      const progress = new Map(toolProgress.get(sessionId) || []);
      progress.set(toolCallId, data);
      toolProgress.set(sessionId, progress);
      return { toolProgress };
    }),
  clearToolProgress: (sessionId, toolCallId) =>
    set((state) => {
      const toolProgress = new Map(state.toolProgress);
      if (!toolCallId) toolProgress.delete(sessionId);
      else {
        const current = toolProgress.get(sessionId);
        if (current) {
          const next = new Map(current);
          next.delete(toolCallId);
          if (next.size === 0) toolProgress.delete(sessionId);
          else toolProgress.set(sessionId, next);
        }
      }
      return { toolProgress };
    }),
  setToolActivity: (sessionId, entries) =>
    set((state) => {
      const toolActivity = new Map(state.toolActivity);
      if (entries.length === 0) toolActivity.delete(sessionId);
      else toolActivity.set(sessionId, entries.slice(-MAX_TOOL_ACTIVITY_PER_SESSION));
      return { toolActivity };
    }),
  upsertToolActivity: (sessionId, entry) =>
    set((state) => {
      const toolActivity = new Map(state.toolActivity);
      const entries = [...(toolActivity.get(sessionId) || [])];
      const index = entries.findIndex((item) => item.toolCallId === entry.toolCallId);
      if (index >= 0) {
        const current = entries[index];
        entries[index] = {
          ...current,
          ...entry,
          startedAt: current.startedAt,
          elapsedSeconds: Math.max(current.elapsedSeconds, entry.elapsedSeconds),
        };
      } else entries.push(entry);
      toolActivity.set(sessionId, entries.slice(-MAX_TOOL_ACTIVITY_PER_SESSION));
      return { toolActivity };
    }),
  updateToolActivity: (sessionId, toolCallId, updates) =>
    set((state) => {
      const toolActivity = new Map(state.toolActivity);
      const entries = toolActivity.get(sessionId);
      if (entries) {
        toolActivity.set(
          sessionId,
          entries.map((entry) =>
            entry.toolCallId === toolCallId ? { ...entry, ...updates } : entry,
          ),
        );
      }
      return { toolActivity };
    }),
});

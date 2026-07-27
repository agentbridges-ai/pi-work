import { useSyncExternalStore } from "react";
import { getPwaLifecycleState, subscribePwaLifecycle } from "./lifecycle.js";

export function usePwaLifecycle() {
  return useSyncExternalStore(subscribePwaLifecycle, getPwaLifecycleState, getPwaLifecycleState);
}

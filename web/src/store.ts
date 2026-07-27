// Barrel re-export — the store implementation lives in store/ slices.
// This file exists so that existing imports from "./store.js" continue to resolve.
export { useStore } from "./store/index.js";
export type { AppState } from "./store/index.js";

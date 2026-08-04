import { previewResourceRegistry } from "../preview-resource-registry.js";
import type { PreviewState, PreviewTab } from "./model.js";

export type OfficePreviewDisposeReason = "close" | "handoff";
export type OfficePreviewDisposer = (reason?: OfficePreviewDisposeReason) => Promise<void> | void;

const officePreviewDisposers = new Map<string, Set<OfficePreviewDisposer>>();

export function hideOfficePreviewHostForTeardown(container: HTMLElement): void {
  container.setAttribute("aria-hidden", "true");
  container.style.display = "none";
  container.style.visibility = "hidden";
  container.style.opacity = "0";
  container.style.pointerEvents = "none";
  container.style.background = "var(--background)";
  for (const frame of container.querySelectorAll("iframe")) {
    frame.setAttribute("aria-hidden", "true");
    frame.style.display = "none";
    frame.style.visibility = "hidden";
    frame.style.opacity = "0";
    frame.style.pointerEvents = "none";
    frame.style.background = "transparent";
  }
}

export function resetOfficePreviewHostForMount(container: HTMLElement): void {
  container.removeAttribute("aria-hidden");
  container.style.display = "";
  container.style.visibility = "";
  container.style.opacity = "";
  container.style.pointerEvents = "";
  container.style.background = "";
}

export function registerOfficePreviewDisposer(
  tabId: string,
  dispose: OfficePreviewDisposer,
): () => void {
  let disposers = officePreviewDisposers.get(tabId);
  if (!disposers) {
    disposers = new Set();
    officePreviewDisposers.set(tabId, disposers);
  }
  disposers.add(dispose);
  return () => {
    const current = officePreviewDisposers.get(tabId);
    if (!current) return;
    current.delete(dispose);
    if (current.size === 0) officePreviewDisposers.delete(tabId);
  };
}

export function disposeOfficePreview(tabId: string): void {
  const disposers = officePreviewDisposers.get(tabId);
  if (!disposers) return;
  officePreviewDisposers.delete(tabId);
  for (const dispose of Array.from(disposers)) {
    void dispose("close");
  }
}

export async function handoffOfficePreview(tabId: string): Promise<void> {
  const disposers = officePreviewDisposers.get(tabId);
  if (!disposers) return;
  for (const dispose of disposers) await Promise.resolve(dispose("handoff"));
}

export function revokePreviewStateUrl(state: PreviewState): void {
  if (state.status !== "ready") return;
  previewResourceRegistry.revoke(state.objectUrl);
  if (state.sourceObjectUrl) previewResourceRegistry.revoke(state.sourceObjectUrl);
}

export function disposePreviewTabResources(tab: PreviewTab): void {
  disposeOfficePreview(tab.id);
  revokePreviewStateUrl(tab.state);
}

export function upsertPreviewTab(
  tabs: PreviewTab[],
  nextTab: PreviewTab,
): { tabs: PreviewTab[]; closedTabs: PreviewTab[] } {
  const index = tabs.findIndex((tab) => tab.id === nextTab.id);
  if (index !== -1) {
    return {
      tabs: tabs.map((tab, tabIndex) => (tabIndex === index ? nextTab : tab)),
      closedTabs: [],
    };
  }
  return {
    tabs: [...tabs, nextTab],
    closedTabs: [],
  };
}

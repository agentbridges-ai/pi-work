import { previewResourceRegistry } from "../components/preview-resource-registry.js";
import { estimateFeedEntryHeight } from "../components/message-feed-estimator.js";
import type { FeedDisplayItem } from "../components/chat-work-groups.js";
import type { IndexedWorkspaceEntry } from "../user-space-index.js";
import { TsUserSpaceMetadataIndex } from "../user-space-ts-index.js";

type UserSpacePerfScenario = "index" | "preview-churn" | "message-height" | "selector-left";

type UserSpacePerfOptions = {
  count?: number;
  width?: number;
  selector?: string;
};

type UserSpacePerfResult = {
  scenario: UserSpacePerfScenario;
  durationMs: number;
  longTaskCount: number;
  longTaskTotalMs: number;
  metrics: Record<string, unknown>;
};

type LongTaskSummary = {
  count: number;
  totalMs: number;
};

type UserSpacePerfDriver = {
  run: (
    scenario: UserSpacePerfScenario,
    options?: UserSpacePerfOptions,
  ) => Promise<UserSpacePerfResult>;
};

declare global {
  interface Window {
    __PIWORK_USER_SPACE_PERF__?: UserSpacePerfDriver;
  }
}

window.__PIWORK_USER_SPACE_PERF__ = {
  run,
};

async function run(
  scenario: UserSpacePerfScenario,
  options: UserSpacePerfOptions = {},
): Promise<UserSpacePerfResult> {
  const started = performance.now();
  const longTasks = observeLongTasks(started);
  const metrics = await runScenario(scenario, options);
  await nextFrame();
  longTasks.stop();
  return {
    scenario,
    durationMs: performance.now() - started,
    longTaskCount: longTasks.summary.count,
    longTaskTotalMs: longTasks.summary.totalMs,
    metrics,
  };
}

async function runScenario(
  scenario: UserSpacePerfScenario,
  options: UserSpacePerfOptions,
): Promise<Record<string, unknown>> {
  if (scenario === "index") return runIndexScenario(options.count || 10_000);
  if (scenario === "preview-churn") return runPreviewChurnScenario(options.count || 100);
  if (scenario === "message-height")
    return runMessageHeightScenario(options.count || 5_000, options.width || 736);
  if (scenario === "selector-left")
    return runSelectorLeftScenario(options.selector || "[data-piwork-user-space-explorer]");
  throw new Error(`Unknown user space perf scenario: ${scenario}`);
}

async function runIndexScenario(count: number): Promise<Record<string, unknown>> {
  const index = await TsUserSpaceMetadataIndex.create(`perf-${crypto.randomUUID()}`);
  const batch: IndexedWorkspaceEntry[] = [];

  for (let i = 0; i < count; i++) {
    const bucket = String(i % 250).padStart(3, "0");
    const marker = i % 1_000 === 0 ? "needle-" : "";
    batch.push(fileEntry(`bucket-${bucket}/${marker}file-${String(i).padStart(6, "0")}.ts`, 512));
  }

  const importStarted = performance.now();
  index.begin();
  index.addBatch(batch);
  const committed = index.commit();
  const importMs = performance.now() - importStarted;
  const firstPage = index.listChildren("bucket-000", 80);
  const search = index.searchPaths("needle-", 100);

  index.begin();
  index.addBatch([fileEntry("aborted/new.txt", 12)]);
  index.abort();
  const abortedVisible = index.searchPaths("aborted", 10).entries.length;
  index.clear();

  return {
    count,
    importMs,
    committed,
    pageSize: firstPage.entries.length,
    nextCursor: firstPage.nextCursor,
    searchMatches: search.entries.length,
    abortedVisible,
    afterClear: index.stats(),
  };
}

function runPreviewChurnScenario(count: number): Record<string, unknown> {
  previewResourceRegistry.revokeAll();
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    urls.push(previewResourceRegistry.create(new Blob([`preview-${i}`], { type: "text/plain" })));
  }
  const created = previewResourceRegistry.size;
  for (const url of urls) previewResourceRegistry.revoke(url);
  const afterRevoke = previewResourceRegistry.size;

  return { count, created, afterRevoke };
}

function runMessageHeightScenario(count: number, width: number): Record<string, unknown> {
  let totalHeight = 0;
  for (let i = 0; i < count; i++) {
    totalHeight += estimateFeedEntryHeight(textFeedEntry(i), width);
  }

  return { count, width, totalHeight };
}

function runSelectorLeftScenario(selector: string): Record<string, unknown> {
  const element = document.querySelector(selector);
  if (!element) return { selector, found: false };
  const rect = element.getBoundingClientRect();
  return { selector, found: true, left: rect.left, width: rect.width };
}

function fileEntry(path: string, size: number): IndexedWorkspaceEntry {
  const name = path.split("/").pop() || path;
  const parentPath = path.slice(0, path.lastIndexOf("/"));
  return {
    name,
    path,
    parentPath,
    kind: "file",
    size,
    lastModified: 1_700_000_000_000,
    ext: name.split(".").pop() || "",
    depth: path.split("/").length,
    previewKind: "text",
  };
}

function textFeedEntry(index: number): FeedDisplayItem {
  const content =
    `Perf message ${index}\n` +
    "The quick brown fox jumps over the lazy dog. ".repeat(8 + (index % 4));
  return {
    kind: "message",
    msg: {
      id: `perf-message-${index}`,
      role: "assistant",
      content,
      contentParts: [{ type: "text", text: content }],
    },
  } as unknown as FeedDisplayItem;
}

function observeLongTasks(started: number): { summary: LongTaskSummary; stop: () => void } {
  const summary: LongTaskSummary = { count: 0, totalMs: 0 };
  if (!("PerformanceObserver" in window)) return { summary, stop: () => {} };

  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime < started) continue;
        summary.count++;
        summary.totalMs += entry.duration;
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    return { summary, stop: () => {} };
  }

  return {
    summary,
    stop: () => observer?.disconnect(),
  };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

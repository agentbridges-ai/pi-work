import type { Hono } from "hono";
import type { PiLauncher } from "../pi-launcher.js";
import { metricsCollector, type GaugeDataProvider } from "../metrics-collector.js";
import type { RecorderManager } from "../recorder.js";
import type { SessionRuntimeSnapshot } from "../session-runtime-state.js";
import { readdirSync } from "node:fs";

function countOpenFileDescriptors(): number | null {
  for (const directory of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return readdirSync(directory).length;
    } catch {}
  }
  return null;
}

export function registerDiagnosticsRoutes(
  api: Hono,
  deps: {
    launcher: PiLauncher;
    gaugeProvider: GaugeDataProvider;
    recorder?: RecorderManager;
    runtimeStateProvider: { listRuntimeStates(): SessionRuntimeSnapshot[] };
    authorize: () => Promise<boolean>;
  },
): void {
  api.get("/diagnostics/runtime", async (c) => {
    if (!(await deps.authorize())) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const sessions = deps.launcher.listSessions();
    const lifecycle = sessions.reduce<Record<string, number>>((counts, session) => {
      counts[session.state] = (counts[session.state] || 0) + 1;
      return counts;
    }, {});
    const supervisor = deps.runtimeStateProvider
      .listRuntimeStates()
      .reduce<Record<string, number>>((counts, session) => {
        counts[session.state] = (counts[session.state] || 0) + 1;
        return counts;
      }, {});
    const memory = process.memoryUsage();
    c.header("Cache-Control", "no-store, max-age=0");
    return c.json({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      runtime: {
        sessions: sessions.length,
        lifecycle,
        supervisor,
        activePiProcesses: sessions.filter((session) => !!session.pid && session.state !== "exited")
          .length,
        openFileDescriptors: countOpenFileDescriptors(),
        memory: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          heapTotal: memory.heapTotal,
          external: memory.external,
          arrayBuffers: memory.arrayBuffers,
        },
      },
      recordings: deps.recorder
        ? {
            enabled: deps.recorder.isGloballyEnabled(),
            policy: deps.recorder.getRetentionPolicy(),
            count: deps.recorder.listRecordings().length,
          }
        : {
            enabled: false,
            policy: null,
            count: 0,
          },
      metrics: metricsCollector.getSnapshot(deps.gaugeProvider),
    });
  });
}

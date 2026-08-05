import type { Hono } from "hono";
import type { GaugeDataProvider } from "../metrics-collector.js";
import { metricsCollector } from "../metrics-collector.js";

export function registerMetricsRoutes(
  api: Hono,
  deps: { gaugeProvider: GaugeDataProvider; authorize: () => Promise<boolean> },
): void {
  api.get("/metrics", async (c) => {
    if (!(await deps.authorize())) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const snapshot = metricsCollector.getSnapshot(deps.gaugeProvider);
    return c.json(snapshot);
  });
}

#!/usr/bin/env bun

const DEBUG_URL = process.env.CHROME_DEBUG_URL || "http://127.0.0.1:9222";
const APP_URL = process.env.PIWORK_PERF_URL || "http://127.0.0.1:5173";
const RESIZE_SELECTOR =
  process.env.PIWORK_PERF_RESIZE_SELECTOR || "[data-piwork-user-space-explorer]";

const scenarios = [];

for (const count of [10_000, 50_000, 100_000]) {
  scenarios.push(["index", { count }]);
}
scenarios.push(["preview-churn", { count: 100 }]);
for (const count of [5_000, 20_000]) {
  scenarios.push(["message-height", { count, width: 736 }]);
}
try {
  const target = await createTarget(APP_URL);
  const client = await CDPClient.connect(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await navigate(client, APP_URL);
  await waitForPerfDriver(client);

  const results = [];
  for (const [name, options] of scenarios) {
    const result = await runPerfScenario(client, name, options);
    results.push(result);
    printResult(result);
  }

  const resize = await runResizeScenario(client);
  results.push(resize);
  printResult(resize);

  client.close();
  enforceSmokeThresholds(results);
  console.log(JSON.stringify({ ok: true, appUrl: APP_URL, results }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Start Chrome with remote debugging, then retry:
  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222

Environment:
  CHROME_DEBUG_URL=${DEBUG_URL}
  PIWORK_PERF_URL=${APP_URL}`);
  process.exit(1);
}

async function createTarget(url) {
  const encoded = encodeURIComponent(url);
  const put = await fetchJson(`${DEBUG_URL}/json/new?${encoded}`, { method: "PUT" }).catch(
    () => null,
  );
  if (put?.webSocketDebuggerUrl) return put;
  const get = await fetchJson(`${DEBUG_URL}/json/new?${encoded}`).catch(() => null);
  if (get?.webSocketDebuggerUrl) return get;
  const pages = await fetchJson(`${DEBUG_URL}/json/list`);
  const page = pages.find((candidate) => candidate.type === "page");
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`No debuggable Chrome page found at ${DEBUG_URL}.`);
  }
  return page;
}

async function navigate(client, url) {
  const loaded = client.waitForEvent("Page.loadEventFired", 30_000).catch(() => undefined);
  await client.send("Page.navigate", { url });
  await loaded;
}

async function waitForPerfDriver(client) {
  const expression = `
    new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (window.__PIWORK_USER_SPACE_PERF__) {
          resolve(true);
          return;
        }
        if (Date.now() - started > 15000) {
          reject(new Error("window.__PIWORK_USER_SPACE_PERF__ was not registered. Run the Vite dev app."));
          return;
        }
        setTimeout(check, 100);
      };
      check();
    })
  `;
  await evaluate(client, expression, 20_000);
}

async function runPerfScenario(client, scenario, options) {
  return evaluate(
    client,
    `window.__PIWORK_USER_SPACE_PERF__.run(${JSON.stringify(scenario)}, ${JSON.stringify(options)})`,
    120_000,
  );
}

async function runResizeScenario(client) {
  const widths = [1440, 1366, 1280, 1180, 1024, 960, 1200, 1440];
  const samples = [];
  const started = performance.now();
  for (let i = 0; i < 100; i++) {
    const width = widths[i % widths.length];
    await client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const sample = await runPerfScenario(client, "selector-left", { selector: RESIZE_SELECTOR });
    samples.push({ width, left: sample.metrics.left, found: sample.metrics.found });
  }
  await client.send("Emulation.clearDeviceMetricsOverride");
  const foundSamples = samples.filter((sample) => sample.found && typeof sample.left === "number");
  const baseline = foundSamples[0]?.left || 0;
  const maxDriftPx = foundSamples.reduce(
    (max, sample) => Math.max(max, Math.abs(sample.left - baseline)),
    0,
  );
  return {
    scenario: "resize-stability",
    durationMs: performance.now() - started,
    longTaskCount: 0,
    longTaskTotalMs: 0,
    metrics: {
      selector: RESIZE_SELECTOR,
      sampleCount: samples.length,
      foundCount: foundSamples.length,
      maxDriftPx,
      samples,
    },
  };
}

function printResult(result) {
  const details = [
    `duration=${result.durationMs.toFixed(1)}ms`,
    `longTasks=${result.longTaskCount}`,
    `longTaskTotal=${result.longTaskTotalMs.toFixed(1)}ms`,
  ];
  console.log(`[${result.scenario}] ${details.join(" ")}`);
}

function enforceSmokeThresholds(results) {
  const preview = results.find((result) => result.scenario === "preview-churn");
  if (preview && preview.metrics.afterRevoke !== 0) {
    throw new Error(`preview-churn leaked ${preview.metrics.afterRevoke} Blob URLs`);
  }

  const resize = results.find((result) => result.scenario === "resize-stability");
  if (resize && resize.metrics.foundCount > 0 && resize.metrics.maxDriftPx > 1) {
    throw new Error(`resize-stability drifted ${resize.metrics.maxDriftPx}px`);
  }
}

async function evaluate(client, expression, timeout) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout,
  });
  if (response.exceptionDetails) {
    const message =
      response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text ||
      "Runtime.evaluate failed";
    throw new Error(message);
  }
  return response.result.value;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok)
    throw new Error(`${options?.method || "GET"} ${url} failed with ${response.status}`);
  return response.json();
}

class CDPClient {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new CDPClient(ws);
      ws.addEventListener("open", () => resolve(client), { once: true });
      ws.addEventListener("error", () => reject(new Error(`Failed to connect to ${url}`)), {
        once: true,
      });
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = new Map();
    this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  waitForEvent(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Timed out waiting for ${method}`)),
        timeoutMs,
      );
      const listeners = this.events.get(method) || [];
      listeners.push((params) => {
        clearTimeout(timeout);
        resolve(params);
      });
      this.events.set(method, listeners);
    });
  }

  close() {
    this.ws.close();
  }

  handleMessage(raw) {
    const message = JSON.parse(raw);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
      return;
    }

    if (!message.method) return;
    const listeners = this.events.get(message.method);
    if (!listeners?.length) return;
    this.events.set(message.method, []);
    for (const listener of listeners) listener(message.params || {});
  }
}

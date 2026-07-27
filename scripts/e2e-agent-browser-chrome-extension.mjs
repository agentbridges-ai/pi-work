#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const release = JSON.parse(
  readFileSync(join(root, "release", "agent-browser-release-manifest.json"), "utf8"),
);
const agentBrowserRoot = resolve(
  process.env.PIWORK_AGENT_BROWSER_DIR || join(root, "agent-browser"),
);
const providerRoot = join(
  agentBrowserRoot,
  "packages",
  "@agent-browser",
  "chrome-extension-provider",
);
const extensionDir = join(providerRoot, ".output", "chrome-mv3");
const pluginPath = join(providerRoot, "dist", "plugin.js");
const daemonPath = join(providerRoot, "dist", "daemon", "cli.js");
const cliPath = join(agentBrowserRoot, "bin", "agent-browser.js");
const pluginRunner = join(root, "scripts", "agent-browser-plugin-runner.mjs");
const bridgePort = Number(process.env.PIWORK_AGENT_BROWSER_BRIDGE_PORT || 19826);
const chromePath = process.env.AGENT_BROWSER_E2E_CHROME || findChrome();

for (const path of [
  join(extensionDir, "manifest.json"),
  pluginPath,
  daemonPath,
  cliPath,
  pluginRunner,
]) {
  assert.equal(existsSync(path), true, `Required agent-browser artifact is missing: ${path}`);
}
assert.ok(
  chromePath,
  "Chrome for Testing or Chromium was not found; set AGENT_BROWSER_E2E_CHROME to an extension-capable binary",
);
assert.equal(
  await bridgeIsRunning(),
  false,
  `Bridge port ${bridgePort} is already in use; stop Piwork before the isolated E2E test`,
);

const tempRoot = mkdtempSync(join(tmpdir(), "nab-"));
const profileDir = join(tempRoot, "chrome-profile");
const socketRoot = "/tmp/piwork-agent-browser";
mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
const socketDir = mkdtempSync(join(socketRoot, "e2e-"));
const controlStatePath = join(tempRoot, "browser-control.json");
mkdirSync(profileDir);

const fixture = createServer((request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(`<!doctype html>
    <html><head><title>Piwork Bridge E2E</title></head>
    <body>
      <label for="name">Name</label>
      <input id="name" aria-label="Name" />
      <button id="save">Save</button>
      <p id="result" aria-live="polite">Not saved</p>
      <script>
        document.getElementById("save").addEventListener("click", () => {
          document.getElementById("result").textContent = "Saved " + document.getElementById("name").value;
        });
      </script>
    </body></html>`);
});
await new Promise((resolveListen, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", resolveListen);
});
const fixtureAddress = fixture.address();
assert.ok(fixtureAddress && typeof fixtureAddress === "object");
const fixtureUrl = `http://127.0.0.1:${fixtureAddress.port}/`;

const session = `e2e-${process.pid}`;
const ownerSessionId = `nex-${createHash("sha256").update(session).digest("hex").slice(0, 16)}`;
const commonEnv = {
  ...process.env,
  AGENT_BROWSER_CHROME_BRIDGE_PORT: String(bridgePort),
  AGENT_BROWSER_CHROME_BRIDGE_DAEMON: daemonPath,
  AGENT_BROWSER_PROVIDER: "chrome-extension",
  AGENT_BROWSER_PLUGINS: JSON.stringify([
    {
      name: "chrome-extension",
      command: process.execPath,
      args: [pluginRunner, pluginPath],
      capabilities: ["browser.provider", "command.run", "chrome-extension.manage"],
    },
  ]),
  AGENT_BROWSER_SOCKET_DIR: socketDir,
  // The smoke uses process-per-command CLI calls, so keep the native session
  // alive deterministically and close it explicitly in the cleanup barrier.
  AGENT_BROWSER_IDLE_TIMEOUT_MS: "0",
  PIWORK_AGENT_BROWSER_SESSION_ID: ownerSessionId,
};
let daemon = spawn(process.execPath, [daemonPath], {
  env: commonEnv,
  stdio: ["ignore", "ignore", "pipe"],
});
const chrome = spawn(
  chromePath,
  [
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--disable-popup-blocking",
    "--remote-debugging-port=0",
    "--enable-logging=stderr",
    "--v=1",
    "--no-proxy-server",
    "--proxy-bypass-list=*",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
let daemonStderr = "";
let chromeStderr = "";
daemon.stderr?.on("data", (chunk) => {
  daemonStderr += String(chunk);
});
chrome.stderr?.on("data", (chunk) => {
  chromeStderr += String(chunk);
});

try {
  await waitFor(async () => isPinnedBridgeHealth(await health()), "pinned bridge daemon startup");
  await waitFor(
    async () => {
      const state = await health();
      return Array.isArray(state?.profiles) && state.profiles.length > 0;
    },
    "real unpacked Chrome extension connection",
    20_000,
  );

  // A browser bridge is long-lived infrastructure. Prove that the unpacked
  // extension reconnects after the daemon disappears before creating a page
  // session, rather than only proving the happy-path first connection.
  await terminate(daemon);
  await waitFor(async () => !(await bridgeIsRunning()), "bridge daemon shutdown");
  daemon = spawn(process.execPath, [daemonPath], {
    env: commonEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  daemon.stderr?.on("data", (chunk) => {
    daemonStderr += String(chunk);
  });
  await waitFor(async () => isPinnedBridgeHealth(await health()), "restarted bridge daemon");
  await waitFor(
    async () => {
      const state = await health();
      return Array.isArray(state?.profiles) && state.profiles.length > 0;
    },
    "extension reconnect after daemon restart",
    20_000,
  );

  const serviceVerification = await verifyPiworkBridgeService();
  assert.equal(serviceVerification.ok, true, "Piwork bridge service verification failed");
  assert.equal(serviceVerification.status?.phase, "connected");

  const status = await runAgentBrowser([
    "plugin",
    "run",
    "chrome-extension",
    "chrome-extension.status",
  ]);
  assert.equal(status.success, true, "provider status command failed");
  assert.ok(
    Array.isArray(status.data?.profiles) && status.data.profiles.length > 0,
    "provider reported no real extension profile",
  );

  assert.equal((await runAgentBrowser(["open", fixtureUrl])).success, true);
  const snapshot = await runAgentBrowser(["snapshot", "-i"]);
  assert.equal(snapshot.success, true);
  assert.match(JSON.stringify(snapshot.data), /Name/);
  assert.match(JSON.stringify(snapshot.data), /Save/);

  assert.equal((await runAgentBrowser(["fill", "#name", "Ada"])).success, true);
  assert.equal((await runAgentBrowser(["type", "#name", " Lovelace"])).success, true);
  assert.equal((await runAgentBrowser(["press", "Tab"])).success, true);
  assert.equal((await runAgentBrowser(["click", "#save"])).success, true);
  const semanticReadback = await runAgentBrowser(["get", "text", "#result"]);
  assert.equal(semanticReadback.success, true);
  assert.match(JSON.stringify(semanticReadback.data), /Saved Ada Lovelace/);

  const urlReadback = await runAgentBrowser(["get", "url"]);
  assert.equal(urlReadback.success, true);
  assert.match(
    JSON.stringify(urlReadback.data),
    new RegExp(`127\\.0\\.0\\.1:${fixtureAddress.port}`),
  );

  const overlay = await runAgentBrowser([
    "eval",
    `Boolean(document.getElementById("__agent_browser_operator_boundary__")?.shadowRoot)`,
  ]);
  assert.match(JSON.stringify(overlay.data), /true/);

  const takeover = await runAgentBrowser([
    "eval",
    `document.getElementById("__agent_browser_operator_boundary__").shadowRoot.querySelector("button").click()`,
  ]);
  assert.equal(takeover.success, true);
  await waitFor(
    async () => (await controlEvents(0)).events?.some((event) => event.action === "takeover"),
    "page takeover event",
  );
  const takeoverState = await runPiworkControl("takeover");
  assert.equal(takeoverState.status, 200);
  assert.equal(takeoverState.body.phase, "human");
  await assert.rejects(() => runAgentBrowser(["get", "url"]), /held by the user/i);

  const handoffSummary = "User verified the saved name and returned browser control.";
  const resumed = await runPiworkControl("resume", handoffSummary);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.phase, "agent", JSON.stringify(resumed));
  assert.equal(resumed.body.reason, "handoff_verified");
  assert.equal(resumed.captured?.summary, handoffSummary);
  assert.match(resumed.captured?.snapshot || "", /Saved Ada Lovelace/);
  const resumedReadback = await runAgentBrowser(["get", "text", "#result"]);
  assert.match(JSON.stringify(resumedReadback.data), /Saved Ada Lovelace/);

  const stop = await runAgentBrowser([
    "eval",
    `Array.from(document.getElementById("__agent_browser_operator_boundary__").shadowRoot.querySelectorAll("button")).find((button) => button.textContent === "Stop").click()`,
  ]);
  assert.equal(stop.success, true);
  await waitFor(
    async () => (await controlEvents(1)).events?.some((event) => event.action === "stop"),
    "page stop event",
  );
  await assert.rejects(() => runAgentBrowser(["get", "url"]), /stopped|not registered/i);

  const tabCloseSession = `${session}-tab-close`;
  assert.equal(
    (await runAgentBrowser(["open", fixtureUrl], 30_000, tabCloseSession)).success,
    true,
  );
  assert.equal(
    (await runAgentBrowser(["tab", "new", fixtureUrl], 30_000, tabCloseSession)).success,
    true,
  );
  assert.equal((await runAgentBrowser(["get", "url"], 30_000, tabCloseSession)).success, true);
  await runAgentBrowser(["tab", "close"], 30_000, tabCloseSession).catch((error) => {
    assert.match(String(error), /stopped/i);
  });
  await waitFor(
    async () => (await controlEvents(2)).events?.some((event) => event.action === "stop"),
    "controlled tab close event",
  );
  await assert.rejects(
    () => runAgentBrowser(["get", "url"], 30_000, tabCloseSession),
    /stopped|not registered/i,
  );
} catch (error) {
  const diagnostics = [
    error instanceof Error ? error.stack || error.message : String(error),
    `Chrome binary: ${chromePath}`,
    daemonStderr ? `daemon stderr:\n${daemonStderr}` : "",
    chromeStderr ? `chrome stderr:\n${chromeStderr}` : "",
    await readChromeTargets(profileDir),
  ]
    .filter(Boolean)
    .join("\n");
  throw new Error(diagnostics);
} finally {
  await runAgentBrowser(["close"]).catch(() => undefined);
  await runAgentBrowser(["close"], 10_000, `${session}-tab-close`).catch(() => undefined);
  await terminate(chrome);
  await terminate(daemon);
  await new Promise((resolveClose) => fixture.close(resolveClose));
  // This Chrome profile is isolated and test-owned. Explicit close exercises
  // native daemon and provider cleanup without touching a user's real tabs.
  rmSync(tempRoot, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}

async function readChromeTargets(profile) {
  try {
    const [port] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split("\n");
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1_000),
    });
    const targets = await response.json();
    return `Chrome targets:\n${JSON.stringify(targets, null, 2)}`;
  } catch (error) {
    return `Chrome targets unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

process.stdout.write(
  "[agent-browser-e2e] PASS real Chrome extension -> daemon reconnect -> CDP -> semantic readback -> authenticated route takeover/summary-resume/stop -> tab-close cleanup\n",
);

function findChrome() {
  const candidates = [
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const browsersRoot of [
    join(homedir(), ".agent-browser", "browsers"),
    join(homedir(), ".cache", "ms-playwright"),
    join(homedir(), "Library", "Caches", "ms-playwright"),
  ]) {
    if (!existsSync(browsersRoot)) continue;
    for (const name of readdirSync(browsersRoot)
      .filter((entry) => /^(chrome|chromium)-/.test(entry))
      .sort()
      .reverse()) {
      const versionRoot = join(browsersRoot, name);
      candidates.push(
        join(
          versionRoot,
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        ),
        join(
          versionRoot,
          "chrome-mac-arm64",
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        ),
        join(
          versionRoot,
          "chrome-mac-x64",
          "Google Chrome for Testing.app",
          "Contents",
          "MacOS",
          "Google Chrome for Testing",
        ),
        join(versionRoot, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      );
    }
  }
  return candidates.find(existsSync) || "";
}

async function bridgeIsRunning() {
  return Boolean(await health());
}

async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${bridgePort}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function isPinnedBridgeHealth(state) {
  return (
    state?.daemon === "ok" &&
    state.version === release.cliVersion &&
    state.bridgeProtocolVersion === release.bridgeProtocolVersion
  );
}

async function runAgentBrowser(args, timeout = 30_000, sessionName = session) {
  const scopedFlags =
    args[0] === "plugin"
      ? []
      : ["--session", opaqueSessionName(sessionName), "--provider", "chrome-extension"];
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, "--json", ...scopedFlags, ...args],
      { env: commonEnv, timeout, maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch (error) {
    const detail = error && typeof error === "object" ? error : {};
    throw new Error(
      [
        `agent-browser command failed: ${args.join(" ")}`,
        typeof detail.stdout === "string" && detail.stdout ? `stdout: ${detail.stdout}` : "",
        typeof detail.stderr === "string" && detail.stderr ? `stderr: ${detail.stderr}` : "",
        error instanceof Error ? error.message : String(error),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `agent-browser returned invalid JSON for ${args.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
}

function opaqueSessionName(sessionName) {
  return `nex-${createHash("sha256").update(sessionName).digest("hex").slice(0, 16)}`;
}

async function verifyPiworkBridgeService() {
  const source = [
    'import { AgentBrowserBridgeService } from "./web/server/agent-browser-bridge-service.ts";',
    "const service = new AgentBrowserBridgeService();",
    "const result = await service.verify();",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const { stdout, stderr } = await execFileAsync("bun", ["--eval", source], {
    cwd: root,
    env: commonEnv,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `Piwork bridge service returned invalid JSON\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
}

async function runPiworkControl(action, summary = "") {
  const source = [
    'import { Hono } from "./web/node_modules/hono/dist/index.js";',
    'import { AgentBrowserBridgeService } from "./web/server/agent-browser-bridge-service.ts";',
    'import { BrowserControlCoordinator } from "./web/server/browser-control-session.ts";',
    'import { registerAgentBrowserRoutes } from "./web/server/routes/agent-browser-routes.ts";',
    "const service = new AgentBrowserBridgeService();",
    "let captured = null;",
    "const control = new BrowserControlCoordinator({",
    `  statePathFor: () => ${JSON.stringify(controlStatePath)},`,
    "  interrupt: async (sessionId) => (await service.setSessionControl(sessionId, 'human')).reachable,",
    "  resume: async (sessionId, deliveredSummary) => {",
    "    const update = await service.setSessionControl(sessionId, 'agent');",
    "    if (!update.reachable || update.matched < 1) return { handoffDelivered: false, semanticReadbackVerified: false };",
    "    try {",
    `      const readback = await service.readSessionSnapshot(sessionId, ${JSON.stringify(socketDir)});`,
    "      captured = { summary: deliveredSummary, snapshot: readback.snapshot };",
    "      return { handoffDelivered: true, semanticReadbackVerified: true };",
    "    } catch (error) {",
    "      captured = { error: error instanceof Error ? error.message : String(error) };",
    "      await service.setSessionControl(sessionId, 'human');",
    "      return { handoffDelivered: false, semanticReadbackVerified: false };",
    "    }",
    "  },",
    "  stop: async (sessionId) => { await service.setSessionControl(sessionId, 'stopped'); },",
    "});",
    "const api = new Hono();",
    "api.use('*', async (context, next) => {",
    "  if (context.req.header('authorization') !== 'Bearer e2e') return context.json({ error: 'Unauthorized' }, 401);",
    "  return next();",
    "});",
    "registerAgentBrowserRoutes(api, { bridge: service, control });",
    `const response = await api.request(${JSON.stringify(`/sessions/${session}/browser-control/${action}`)}, {`,
    "  method: 'POST',",
    "  headers: { authorization: 'Bearer e2e', 'content-type': 'application/json' },",
    `  body: ${action === "resume" ? `JSON.stringify({ summary: ${JSON.stringify(summary)} })` : "undefined"},`,
    "});",
    "const body = await response.json();",
    "process.stdout.write(JSON.stringify({ status: response.status, body, captured }));",
  ].join("\n");
  const { stdout, stderr } = await execFileAsync("bun", ["--eval", source], {
    cwd: root,
    env: commonEnv,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(
      `Piwork browser-control route returned invalid JSON\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
}

async function controlEvents(after) {
  const response = await fetch(
    `http://127.0.0.1:${bridgePort}/control/events?after=${encodeURIComponent(after)}`,
    { signal: AbortSignal.timeout(1_000) },
  );
  assert.equal(response.ok, true);
  return await response.json();
}

async function waitFor(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

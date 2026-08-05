import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../server/path-resolver.js";
import { compileSrtPolicy } from "../server/srt-policy.js";
import { createPiProbeLayout, runPiRpcProbe } from "./pi-rpc-probe.js";

if (process.platform !== "linux") {
  throw new Error(
    "The production Pi SRT smoke must run on Linux; use OrbStack Linux on macOS or WSL2 Linux on Windows.",
  );
}

const node = resolveBinary("node");
const srt = resolveBinary("srt");
if (!node) throw new Error("Node.js is required for native Pi rpc-entry.");
if (!srt) throw new Error("Pinned repo-local SRT executable was not found.");
const executionMode =
  process.env.PIWORK_RUNTIME_DEPLOYMENT_MODE === "compose-nested" ? "compose-nested" : "native";

const rpcEntry = realpathSync(
  fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry")),
);
const piPackageJson = join(dirname(dirname(rpcEntry)), "package.json");
const piPackage = JSON.parse(readFileSync(piPackageJson, "utf8")) as { version?: string };
if (piPackage.version !== "0.82.1") {
  throw new Error(`Expected Pi 0.82.1, found ${piPackage.version || "unknown"}.`);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "piwork-srt-pi-rpc-")));
// SRT creates its proxy sockets under the host-side TMPDIR. Keep that manager
// directory short and launch-private so the Compose wrapper can rebind the
// whole directory with its existing directory-FD rule. The sandbox still
// receives SRT's normal /tmp setting through the generated policy.
const proxyRoot = realpathSync(mkdtempSync(join(tmpdir(), "piwork-pi-rpc-")));
const proxyDir = join(proxyRoot, "proxy");
mkdirSync(proxyDir, { mode: 0o700 });
if (!/^\/tmp\/piwork-pi-[^/]+\/proxy$/u.test(proxyDir)) {
  throw new Error(`Pi RPC probe proxy directory escaped the Compose socket contract: ${proxyDir}`);
}
try {
  const tenantsRoot = join(root, "tenants");
  const tenantRoot = join(tenantsRoot, "tenant");
  const sessionRoot = join(tenantRoot, "sessions", "current");
  mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
  const layout = createPiProbeLayout(sessionRoot);
  const settingsPath = join(layout.tmpDir, "srt-settings.json");
  const nodeModulesRoot = realpathSync(join(import.meta.dirname, "..", "node_modules"));
  const policyInput = {
    tenantsRoot,
    tenantRoot,
    sessionRoot,
    workspaceDir: layout.workspaceDir,
    homeDir: layout.homeDir,
    tmpDir: layout.tmpDir,
    piConfigDir: layout.piConfigDir,
    piSessionsDir: layout.piSessionsDir,
    deniedSessionDirs: [layout.recordingsDir, layout.userSpaceCheckoutsDir],
    knowledgeDirs: [],
    runtimeReadPaths: [realpathSync(node), nodeModulesRoot],
    requiredInternalDomains: [],
    domainLayers: [],
    executionMode,
  };
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      compileSrtPolicy(policyInput as unknown as Parameters<typeof compileSrtPolicy>[0]),
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const result = await runPiRpcProbe(
    {
      executable: srt,
      prefixArgs: ["--settings", settingsPath, node, rpcEntry],
      env: { TMPDIR: proxyDir },
    },
    layout,
  );
  console.log(
    `[srt-pi-rpc] real Pi ${piPackage.version} rpc-entry passed inside Linux SRT (${executionMode}) ` +
      `with isolated pi-config/pi-sessions and exact JSONL resume ` +
      `(${result.modelCount} models, ${result.commandCount} commands).`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(proxyRoot, { recursive: true, force: true });
}

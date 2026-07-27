#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(repositoryRoot, "web");
const expected = {
  pi: {
    name: "@earendil-works/pi-coding-agent",
    version: "0.82.1",
  },
  mcp: {
    name: "@modelcontextprotocol/sdk",
    version: "1.29.0",
  },
};

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function packagePath(name) {
  return join(webRoot, "node_modules", ...name.split("/"), "package.json");
}

const rootManifest = readJson(join(repositoryRoot, "package.json"));
const webManifest = readJson(join(webRoot, "package.json"));
for (const manifest of [rootManifest, webManifest]) {
  if (manifest.engines?.node !== ">=22.19.0") {
    throw new Error(`${manifest.name || "package"} must require Node.js >=22.19.0`);
  }
}

for (const dependency of Object.values(expected)) {
  if (webManifest.dependencies?.[dependency.name] !== dependency.version) {
    throw new Error(
      `${dependency.name} must be an exact direct dependency at ${dependency.version}`,
    );
  }
  const installedPath = packagePath(dependency.name);
  if (!existsSync(installedPath)) {
    throw new Error(`${dependency.name} is not installed; run make install first`);
  }
  const installed = readJson(installedPath);
  if (installed.name !== dependency.name || installed.version !== dependency.version) {
    throw new Error(
      `${dependency.name} install mismatch: expected ${dependency.version}, found ${
        installed.version || "unknown"
      }`,
    );
  }
}

const directMarioDependencies = Object.keys(webManifest.dependencies || {}).filter((name) =>
  name.startsWith("@mariozechner/"),
);
if (directMarioDependencies.length > 0) {
  throw new Error(
    `Forbidden direct @mariozechner dependencies: ${directMarioDependencies.join(", ")}`,
  );
}

const piManifestPath = packagePath(expected.pi.name);
const piManifest = readJson(piManifestPath);
if (piManifest.engines?.node !== ">=22.19.0") {
  throw new Error("Pinned Pi package must declare Node.js >=22.19.0");
}
const rpcExport = piManifest.exports?.["./rpc-entry"]?.import;
if (rpcExport !== "./dist/rpc-entry.js") {
  throw new Error("Pinned Pi package must expose the native ./dist/rpc-entry.js import");
}
const rpcEntry = realpathSync(resolve(dirname(piManifestPath), rpcExport));
if (!statSync(rpcEntry).isFile()) {
  throw new Error("Pinned Pi rpc-entry export is not a regular file");
}

const optionalMario = Object.entries(piManifest.optionalDependencies || {});
if (
  optionalMario.length !== 1 ||
  optionalMario[0]?.[0] !== "@mariozechner/clipboard" ||
  optionalMario[0]?.[1] !== "0.3.9"
) {
  throw new Error("Unexpected upstream optional dependency in the pinned Pi package");
}

console.log("[native-pi] Pi 0.82.1 rpc-entry, MCP SDK 1.29.0, and Node.js >=22.19.0 pins verified");

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, "release/agent-browser-release-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const failures = [];
if (manifest.schemaVersion !== 1) failures.push("schemaVersion must be 1");
if (
  !/^https:\/\/github\.com\/agentbridges-ai\/agent-browser\.git$/.test(manifest.repository || "")
) {
  failures.push("repository must pin agentbridges-ai/agent-browser");
}
if (!/^[0-9a-f]{40}$/.test(manifest.commitSha || ""))
  failures.push("commitSha must be a full Git SHA");
if (manifest.sourceBranch !== "feat/chrome-extension-connection") {
  failures.push("sourceBranch must pin feat/chrome-extension-connection");
}
const hasStagingSource =
  manifest.fetchRepository !== undefined ||
  manifest.fetchBranch !== undefined ||
  manifest.upstreamPullRequest !== undefined;
if (
  hasStagingSource &&
  (manifest.fetchRepository !== "https://github.com/2217173240/agent-browser.git" ||
    manifest.fetchBranch !== "xinyu/browser-control-loop" ||
    manifest.upstreamPullRequest !== "https://github.com/agentbridges-ai/agent-browser/pull/1")
) {
  failures.push("staging source must match the reviewed agent-browser pull request");
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.cliVersion || "")) failures.push("cliVersion must be semver");
if (manifest.providerPackage !== "packages/@agent-browser/chrome-extension-provider") {
  failures.push("providerPackage must name the Chrome extension provider workspace");
}
if (manifest.bridgeProtocolVersion !== 1) failures.push("bridgeProtocolVersion must be 1");
if (
  !Number.isInteger(manifest.defaultBridgePort) ||
  manifest.defaultBridgePort < 1 ||
  manifest.defaultBridgePort > 65535
) {
  failures.push("defaultBridgePort must be a valid TCP port");
}
for (const required of [
  "scripts/ensure-agent-browser.sh",
  "scripts/agent-browser-plugin-runner.mjs",
  "scripts/e2e-agent-browser-chrome-extension.mjs",
  ".gitignore",
]) {
  if (!existsSync(resolve(root, required))) failures.push(`${required} is missing`);
}

if (failures.length) {
  for (const failure of failures) console.error(`[agent-browser-release] ${failure}`);
  process.exit(1);
}

console.log(`[agent-browser-release] manifest ok: ${manifest.cliVersion} @ ${manifest.commitSha}`);

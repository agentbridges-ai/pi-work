import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ENV, environment } from "./environment.js";

export interface BuildInfo {
  version: string;
  apiContractVersion: string;
  gitSha: string;
  buildTime: string;
  buildTag: string;
  imageTag: string;
  distIndexAsset: string | null;
}

export const API_CONTRACT_VERSION = "piwork-api-2026-06-14-user-space-cli-v2";

function readPackageVersion(packageRoot: string): string {
  try {
    const raw = readFileSync(resolve(packageRoot, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

function readDistIndexAsset(packageRoot: string): string | null {
  const indexPath = resolve(packageRoot, "dist", "index.html");
  if (!existsSync(indexPath)) return null;
  try {
    const html = readFileSync(indexPath, "utf-8");
    return html.match(/src="([^"]*\/assets\/index-[^"]+\.js)"/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function getBuildInfo(packageRoot: string): BuildInfo {
  return {
    version: environment.string(ENV.PIWORK_VERSION, readPackageVersion(packageRoot), false),
    apiContractVersion: environment.string(ENV.PIWORK_API_CONTRACT_VERSION, API_CONTRACT_VERSION),
    gitSha: environment.string(ENV.PIWORK_BUILD_GIT_SHA, "unknown"),
    buildTime: environment.string(ENV.PIWORK_BUILD_TIME, "unknown"),
    buildTag: environment.string(ENV.PIWORK_BUILD_TAG, "unknown"),
    imageTag: environment.string(ENV.PIWORK_IMAGE_TAG, "unknown"),
    distIndexAsset: readDistIndexAsset(packageRoot),
  };
}

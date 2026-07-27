import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePiRpcOutputJson, PI_CODING_AGENT_VERSION } from "../server/pi-rpc-contract.js";
import { resolveBinary } from "../server/path-resolver.js";
import { PiJsonlFrameError, StrictLfJsonlDecoder } from "../server/pi-rpc-transport.js";
import { createPiProbeLayout, runPiRpcProbe } from "./pi-rpc-probe.js";

interface PackageManifest {
  name?: string;
  version?: string;
  engines?: { node?: string };
  exports?: Record<string, unknown>;
}

function readPinnedManifest(path: string): PackageManifest {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) {
      throw new Error("Pinned Pi package manifest is not an ordinary bounded file.");
    }
    return JSON.parse(readFileSync(fd, "utf8")) as PackageManifest;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function verifyInstalledPackage(): string {
  // The pinned package exposes rpc-entry only for ESM import. Resolving through
  // createRequire would test an unsupported "require" condition.
  const rpcEntry = realpathSync(
    fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry")),
  );
  const packageRoot = realpathSync(join(dirname(rpcEntry), ".."));
  const manifest = readPinnedManifest(join(packageRoot, "package.json"));
  const rpcExport = manifest.exports?.["./rpc-entry"];
  if (
    manifest.name !== "@earendil-works/pi-coding-agent" ||
    manifest.version !== PI_CODING_AGENT_VERSION
  ) {
    throw new Error(
      `Expected native Pi ${PI_CODING_AGENT_VERSION}; installed package does not match.`,
    );
  }
  if (
    !rpcExport ||
    typeof rpcExport !== "object" ||
    (rpcExport as { import?: unknown }).import !== "./dist/rpc-entry.js" ||
    rpcEntry !== realpathSync(join(packageRoot, "dist", "rpc-entry.js"))
  ) {
    throw new Error("Pinned Pi package does not export the exact native rpc-entry.");
  }
  if (manifest.engines?.node !== ">=22.19.0") {
    throw new Error("Pinned Pi package does not declare Node >=22.19.0.");
  }
  return rpcEntry;
}

function verifyLocalFramingContract(): void {
  const decoder = new StrictLfJsonlDecoder(4_096);
  const first =
    '{"type":"extension_error","extensionPath":"trusted","event":"test","error":"left right"}';
  const records = [
    ...decoder.push(first.slice(0, 13)),
    ...decoder.push(`${first.slice(13)}\n{"type":"agent_settled"}\n`),
  ];
  decoder.end();
  if (records.length !== 2) {
    throw new Error("Strict LF Pi JSONL fragmentation contract failed.");
  }
  parsePiRpcOutputJson(records[0]!);
  parsePiRpcOutputJson(records[1]!);

  try {
    new StrictLfJsonlDecoder(4_096).push('{"type":"agent_settled"}\r\n');
    throw new Error("Strict LF Pi JSONL decoder accepted a CRLF frame.");
  } catch (error) {
    if (!(error instanceof PiJsonlFrameError) || error.code !== "invalid_frame") {
      throw error;
    }
  }
}

export async function verifyPiRpcContract(): Promise<void> {
  const rpcEntry = verifyInstalledPackage();
  verifyLocalFramingContract();
  const node = resolveBinary("node");
  if (!node) throw new Error("Node.js is required for native Pi rpc-entry.");

  const root = mkdtempSync(join(tmpdir(), "piwork-pi-rpc-contract-"));
  try {
    const result = await runPiRpcProbe(
      { executable: node, prefixArgs: [rpcEntry] },
      createPiProbeLayout(root),
    );
    console.log(
      `[pi-rpc-contract] native Pi ${PI_CODING_AGENT_VERSION}, strict LF JSONL, request IDs, ` +
        `explicit extension, managed Skills, models and exact history resume passed ` +
        `(${result.modelCount} models, ${result.commandCount} commands).`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await verifyPiRpcContract();

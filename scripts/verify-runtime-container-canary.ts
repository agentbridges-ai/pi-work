import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSE_NESTED_BWRAP_PATH, compileSrtPolicy } from "../web/server/srt-policy.js";
import { preparePiSessionLayout } from "../web/server/pi-session-layout.js";
import { resolvePinnedSrtRuntime } from "../web/server/pi-runtime-resolver.js";

if (process.platform !== "linux") throw new Error("Runtime container canary requires Linux");
if (typeof process.getuid === "function" && process.getuid() !== 65532) {
  throw new Error("Runtime canary requires the non-root piwork UID");
}
if (typeof process.getgid === "function" && process.getgid() !== 65532) {
  throw new Error("Runtime canary requires the non-root piwork GID");
}
if (!existsSync("/proc/1/status")) throw new Error("Runtime canary cannot inspect /proc");
const status = readFileSync("/proc/1/status", "utf8");
const capEff = status.match(/^CapEff:\s*([0-9a-f]+)$/mu)?.[1];
if (capEff && !/^0+$/u.test(capEff)) throw new Error("Runtime container retained capabilities");

const bwrap = spawnSync(
  COMPOSE_NESTED_BWRAP_PATH,
  [
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--unshare-pid",
    "--unshare-user",
    "--bind",
    "/proc",
    "/proc",
    "--",
    "/bin/sh",
    "-eu",
    "-c",
    'test "$$" != "$PPID"; test -r /proc/self/status',
  ],
  { encoding: "utf8" },
);
if (bwrap.status !== 0) {
  const details = [
    bwrap.error ? `error=${bwrap.error.message}` : "",
    bwrap.signal ? `signal=${bwrap.signal}` : "",
    bwrap.stdout?.trim() ? `stdout=${bwrap.stdout.trim().slice(0, 2_000)}` : "",
    bwrap.stderr?.trim() ? `stderr=${bwrap.stderr.trim().slice(0, 4_000)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  throw new Error(
    `Nested SRT canary failed (${bwrap.status ?? bwrap.signal ?? "unknown"})${details ? ` ${details}` : ""}`,
  );
}

const dataRoot = realpathSync(process.env.PIWORK_DATA_ROOT || "/var/lib/piwork/data");
const canaryRoot = mkdtempSync(join(dataRoot, ".runtime", "security-canary-"));
let settingsPath: string | undefined;
try {
  const tenantRoot = join(canaryRoot, "tenants", "tenant-a");
  const otherTenantRoot = join(canaryRoot, "tenants", "tenant-b");
  const sessionRoot = join(
    tenantRoot,
    "users",
    "user-a",
    "sessions",
    "11111111-1111-4111-8111-111111111111",
  );
  const otherSessionRoot = join(
    otherTenantRoot,
    "users",
    "user-b",
    "sessions",
    "22222222-2222-4222-8222-222222222222",
  );
  mkdirSync(join(tenantRoot, "knowledge", "root"), { recursive: true, mode: 0o700 });
  mkdirSync(join(otherSessionRoot, "workspace"), { recursive: true, mode: 0o700 });
  writeFileSync(join(otherSessionRoot, "workspace", "secret.txt"), "cross-tenant-canary\n", {
    mode: 0o600,
  });
  const layout = preparePiSessionLayout(sessionRoot);
  const otherLayout = preparePiSessionLayout(otherSessionRoot);
  settingsPath = join(tmpdir(), `piwork-runtime-canary-${process.pid}.json`);
  const policy = compileSrtPolicy({
    tenantsRoot: join(canaryRoot, "tenants"),
    tenantRoot,
    sessionRoot: layout.sessionRoot,
    workspaceDir: layout.workspaceDir,
    homeDir: layout.homeDir,
    tmpDir: layout.tmpDir,
    piConfigDir: layout.piRuntimeConfigDir,
    piSessionsDir: layout.piSessionsDir,
    deniedSessionDirs: [layout.recordingsDir, layout.userSpaceCheckoutsDir],
    managedReadPaths: [],
    knowledgeDirs: [join(tenantRoot, "knowledge", "root")],
    // The production PiLauncher augments every policy with the pinned SRT
    // package root. Without this grant the policy correctly masks /workspace,
    // which would also hide SRT's own apply-seccomp helper inside the nested
    // bwrap namespace.
    runtimeReadPaths: [resolvePinnedSrtRuntime().packageRoot],
    unixSocketPaths: [],
    requiredInternalDomains: [],
    domainLayers: [],
    executionMode: "compose-nested",
  });
  writeFileSync(settingsPath, JSON.stringify(policy), { mode: 0o600 });
  const srt = resolvePinnedSrtRuntime();
  const script = `
echo CANARY_STAGE=filesystem
test -w "$OWN/workspace"
test -w "$OWN/home"
test ! -r "$OTHER/workspace/secret.txt"
test ! -w "$TENANT/knowledge/root"
test ! -r "$OWN/recordings"
echo CANARY_STAGE=process
for entry in /proc/[0-9]*; do
  if test -r "$entry/cmdline"; then
    cmd="$(tr '\\0' ' ' < "$entry/cmdline" || true)"
    case "$cmd" in
      *verify-runtime-container-canary.ts*|*sandbox-runtime/dist/cli.js*) continue ;;
      *vite*|*server/index.ts*|*web-entrypoint*)
        echo "CANARY_PROCESS_MATCH=$entry:$cmd"
        exit 42
        ;;
    esac
  fi
done
echo CANARY_STAGE=setsid
setsid /bin/sh -eu -c 'test -r /proc/self/status' &
child="$!"
wait "$child"
echo CANARY_STAGE=network
! /usr/bin/curl --connect-timeout 1 --max-time 2 http://example.com
echo CANARY_STAGE=unix
! /usr/bin/timeout 2 /usr/bin/socat UNIX-LISTEN="$OWN/workspace/blocked.sock",fork EXEC:/bin/true
echo CANARY_STAGE=done
`;
  const sandbox = spawnSync(
    srt.entryPath,
    ["--settings", settingsPath, "/bin/sh", "-eu", "-c", script],
    {
      cwd: layout.workspaceDir,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: layout.homeDir,
        TMPDIR: "/tmp",
        OWN: layout.sessionRoot,
        OTHER: otherLayout.sessionRoot,
        TENANT: tenantRoot,
        LANG: "C",
        LC_ALL: "C",
        SRT_DEBUG: process.env.SRT_DEBUG || "",
      },
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    },
  );
  if (sandbox.status !== 0) {
    throw new Error(
      `Per-session SRT isolation canary failed (${sandbox.status ?? sandbox.signal ?? "unknown"})` +
        (sandbox.stdout?.trim() ? ` stdout=${sandbox.stdout.trim().slice(0, 2_000)}` : "") +
        (sandbox.stderr?.trim() ? ` stderr=${sandbox.stderr.trim().slice(0, 4_000)}` : ""),
    );
  }
  console.log(
    JSON.stringify({
      contract: "piwork-runtime-security-v1",
      configured: true,
      verified: true,
      nestedSrt: "passed",
      crossTenantFilesystem: "passed",
      processNamespace: "passed",
      network: "passed",
      unixSocketPolicy: "passed",
      uid: typeof process.getuid === "function" ? process.getuid() : null,
    }),
  );
} finally {
  if (settingsPath) rmSync(settingsPath, { force: true });
  rmSync(canaryRoot, { recursive: true, force: true });
}

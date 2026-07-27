#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ROOT_PARENT="$(dirname "$ROOT_DIR")"
RUNTIME_DIR="$ROOT_DIR/.runtime"

fail() {
  printf '[pi-reset] %s\n' "$*" >&2
  exit 2
}

command -v node >/dev/null 2>&1 || fail "Node.js is required."

canonical_candidate() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const target = path.resolve(process.argv[1]);
    let cursor = target;
    const missing = [];
    while (true) {
      let info;
      try {
        info = fs.lstatSync(cursor);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        const parent = path.dirname(cursor);
        if (parent === cursor) throw error;
        missing.unshift(path.basename(cursor));
        cursor = parent;
        continue;
      }
      if (info.isSymbolicLink()) {
        process.stdout.write(path.resolve(fs.realpathSync(cursor), ...missing));
        break;
      }
      if (!info.isDirectory()) throw new Error(`Non-directory path ancestor: ${cursor}`);
      process.stdout.write(path.resolve(fs.realpathSync(cursor), ...missing));
      break;
    }
  ' "$1"
}

DATA_ROOT="$(node -e '
  const path = require("node:path");
  process.stdout.write(path.resolve(process.argv[1], process.argv[2]));
' "$ROOT_DIR" "${PIWORK_DATA_ROOT:-data}")"
HOME_ROOT="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "${HOME:-/}")"

case "$DATA_ROOT" in
  /|"$ROOT_DIR"|"$HOME_ROOT"|"$ROOT_PARENT")
    fail "Refusing unsafe data root: $DATA_ROOT"
    ;;
esac

if [[ -e "$DATA_ROOT" && ! -d "$DATA_ROOT" ]]; then
  fail "Data root must be a directory: $DATA_ROOT"
fi
CANONICAL_DATA_ROOT="$(canonical_candidate "$DATA_ROOT")" ||
  fail "Unable to validate data root: $DATA_ROOT"
[[ "$CANONICAL_DATA_ROOT" == "$DATA_ROOT" ]] ||
  fail "Data root must not traverse symbolic-link aliases: $DATA_ROOT"

DEFAULT_DATA_ROOT="$ROOT_DIR/data"
if [[ "$DATA_ROOT" != "$DEFAULT_DATA_ROOT" && "${CONFIRM_EXTERNAL_PI_DATA_ROOT:-0}" != "1" ]]; then
  fail "External data root requires CONFIRM_EXTERNAL_PI_DATA_ROOT=1: $DATA_ROOT"
fi

APPLY=0
if [[ "${CONFIRM_PI_SESSION_RESET:-0}" == "1" ]]; then
  APPLY=1
fi

LOCK_DIR="$(node -e '
  const path = require("node:path");
  process.stdout.write(path.resolve(process.argv[1], process.argv[2]));
' "$ROOT_DIR" "${PIWORK_MAINTENANCE_LOCK_DIR:-.runtime/maintenance-backup.lock}")"
case "$LOCK_DIR" in
  /|"$ROOT_DIR"|"$HOME_ROOT"|"$DATA_ROOT")
    fail "Refusing unsafe maintenance lock path: $LOCK_DIR"
    ;;
esac
CANONICAL_LOCK_DIR="$(canonical_candidate "$LOCK_DIR")" ||
  fail "Unable to validate maintenance lock path: $LOCK_DIR"
[[ "$CANONICAL_LOCK_DIR" == "$LOCK_DIR" ]] ||
  fail "Maintenance lock path must not traverse symbolic-link aliases: $LOCK_DIR"

lock_acquired=0
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$lock_acquired" == "1" ]]; then
    rm -f -- "$LOCK_DIR/pid"
    if ! rmdir -- "$LOCK_DIR" 2>/dev/null; then
      printf '[pi-reset] warning: maintenance lock could not be removed: %s\n' "$LOCK_DIR" >&2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

if [[ "$APPLY" == "1" ]]; then
  mkdir -p -- "$(dirname "$LOCK_DIR")"
  CANONICAL_LOCK_PARENT="$(canonical_candidate "$(dirname "$LOCK_DIR")")" ||
    fail "Unable to validate maintenance lock parent: $(dirname "$LOCK_DIR")"
  [[ "$CANONICAL_LOCK_PARENT" == "$(dirname "$LOCK_DIR")" ]] ||
    fail "Maintenance lock parent must not traverse symbolic-link aliases: $(dirname "$LOCK_DIR")"
  if ! mkdir -m 0700 -- "$LOCK_DIR" 2>/dev/null; then
    fail "Maintenance lock is already held: $LOCK_DIR"
  fi
  lock_acquired=1
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  chmod 0600 "$LOCK_DIR/pid"
elif [[ -e "$LOCK_DIR" ]]; then
  fail "Maintenance lock is already held: $LOCK_DIR"
fi

for pid_file in "$RUNTIME_DIR"/*.pid "$DATA_ROOT"/.runtime/*.pid; do
  [[ -e "$pid_file" || -L "$pid_file" ]] || continue
  [[ ! -L "$pid_file" && -f "$pid_file" ]] ||
    fail "Runtime PID path must be a regular file: $pid_file"
  CANONICAL_PID_PARENT="$(canonical_candidate "$(dirname "$pid_file")")" ||
    fail "Unable to validate runtime PID directory: $(dirname "$pid_file")"
  [[ "$CANONICAL_PID_PARENT" == "$(dirname "$pid_file")" ]] ||
    fail "Runtime PID path must not traverse symbolic-link aliases: $pid_file"
  if ! runtime_pid="$(node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const info = fs.lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64) {
      process.exit(1);
    }
    const value = fs.readFileSync(path, "utf8");
    if (!/^[1-9][0-9]*\n?$/.test(value)) process.exit(1);
    const pid = Number(value.trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) process.exit(1);
    process.stdout.write(String(pid));
  ' "$pid_file")"; then
    fail "Runtime PID file is invalid: $pid_file"
  fi
  if kill -0 "$runtime_pid" >/dev/null 2>&1; then
    fail "Active Piwork runtime process $runtime_pid was found; stop it before resetting."
  fi
done

RUNNER_LOCK_PATH="${PIWORK_RUNNER_LOCK_PATH:-${PIWORK_HOME:-$HOME/.piwork}/runner.lock}"
RUNNER_LOCK_PATH="$(node -e '
  process.stdout.write(require("node:path").resolve(process.argv[1]));
' "$RUNNER_LOCK_PATH")"
case "$RUNNER_LOCK_PATH" in
  /|"$ROOT_DIR"|"$HOME_ROOT"|"$DATA_ROOT")
    fail "Refusing unsafe runner lock path: $RUNNER_LOCK_PATH"
    ;;
esac
CANONICAL_RUNNER_PARENT="$(canonical_candidate "$(dirname "$RUNNER_LOCK_PATH")")" ||
  fail "Unable to validate runner lock directory: $(dirname "$RUNNER_LOCK_PATH")"
[[ "$CANONICAL_RUNNER_PARENT" == "$(dirname "$RUNNER_LOCK_PATH")" ]] ||
  fail "Runner lock path must not traverse symbolic-link aliases: $RUNNER_LOCK_PATH"
if [[ -e "$RUNNER_LOCK_PATH" || -L "$RUNNER_LOCK_PATH" ]]; then
  [[ ! -L "$RUNNER_LOCK_PATH" && -f "$RUNNER_LOCK_PATH" ]] ||
    fail "Runner lock must be a regular file: $RUNNER_LOCK_PATH"
  if ! runner_state="$(node -e '
    const fs = require("node:fs");
    try {
      const info = fs.lstatSync(process.argv[1]);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024) {
        process.exit(2);
      }
      const lock = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const heartbeat = Number(lock.heartbeatAt);
      const pid = Number(lock.pid);
      const fresh = Number.isFinite(heartbeat) && Date.now() - heartbeat <= 45_000;
      let live = false;
      if (Number.isSafeInteger(pid) && pid > 1) {
        try { process.kill(pid, 0); live = true; } catch {}
      }
      process.stdout.write(fresh || live ? "active" : "stale");
    } catch {
      process.exit(2);
    }
  ' "$RUNNER_LOCK_PATH")"; then
    fail "Runner lock is malformed or unsafe: $RUNNER_LOCK_PATH"
  fi
  if [[ "$runner_state" == "active" ]]; then
    fail "An active Piwork runner lock exists; stop the writer before resetting."
  fi
fi

printf '[pi-reset] mode: %s\n' "$([[ "$APPLY" == "1" ]] && echo APPLY || echo 'DRY RUN')"
printf '[pi-reset] data root: %s\n' "$DATA_ROOT"

PI_RESET_DATA_ROOT="$DATA_ROOT" PI_RESET_APPLY="$APPLY" node <<'NODE'
const {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { randomUUID } = require("node:crypto");
const { TextDecoder } = require("node:util");

const dataRoot = resolve(process.env.PI_RESET_DATA_ROOT);
const apply = process.env.PI_RESET_APPLY === "1";
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_SKILLS = 100;
const MAX_FILES_PER_SKILL = 100;
const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 256 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_FILE = /(^|\/)(\.env|id_rsa|credentials?|secrets?)(\.|$)/i;
const WARNING_CONTENT =
  /\b(curl|wget|nc|ncat|ssh|scp|child_process|subprocess|os\.system|eval\s*\(|exec\s*\(|api[_ -]?key|password|private[_ -]?key|credential|token)\b/i;
const SAFE_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

function fail(message) {
  throw new Error(message);
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertCanonicalPath(path, label, scope = dataRoot) {
  const requested = resolve(path);
  const requestedScope = resolve(scope);
  if (!inside(dataRoot, requested) || !inside(requestedScope, requested)) {
    fail(`${label} escapes its authorized root: ${path}`);
  }
  let cursor = requested;
  const missing = [];
  while (true) {
    let info;
    try {
      info = lstatSync(cursor);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) fail(`${label} has no safe existing ancestor: ${path}`);
      missing.unshift(basename(cursor));
      cursor = parent;
      continue;
    }
    if (info.isSymbolicLink()) fail(`${label} must not traverse symbolic links: ${path}`);
    if (missing.length > 0 && !info.isDirectory()) {
      fail(`${label} traverses a non-directory ancestor: ${path}`);
    }
    const canonical = realpathSync(cursor);
    if (canonical !== cursor) fail(`${label} must not traverse symbolic-link aliases: ${path}`);
    const prospective = resolve(canonical, ...missing);
    if (
      prospective !== requested ||
      !inside(dataRoot, prospective) ||
      !inside(requestedScope, prospective)
    ) {
      fail(`${label} escapes its authorized root: ${path}`);
    }
    return requested;
  }
}

function safeExistingDirectory(path, label, scope = dataRoot) {
  const requested = assertCanonicalPath(path, label, scope);
  const info = lstatSync(requested);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(`${label} must be a real directory: ${path}`);
  }
  const canonical = realpathSync(requested);
  if (canonical !== requested || !inside(dataRoot, canonical) || !inside(resolve(scope), canonical)) {
    fail(`${label} escapes its authorized root: ${path}`);
  }
  return canonical;
}

if (pathExists(dataRoot)) {
  const info = lstatSync(dataRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(dataRoot) !== dataRoot) {
    fail(`Unsafe data root: ${dataRoot}`);
  }
}

function directoryEntries(path) {
  return pathExists(path) ? readdirSync(path, { withFileTypes: true }) : [];
}

function discoverUserRoots() {
  if (!pathExists(dataRoot)) return [];
  const roots = [];
  for (const entry of directoryEntries(dataRoot)) {
    if (entry.name === ".runtime" || entry.name === "tenants") continue;
    if (entry.isSymbolicLink()) fail(`User root must not be a symbolic link: ${entry.name}`);
    if (entry.isDirectory()) roots.push(safeExistingDirectory(join(dataRoot, entry.name), "User root"));
  }
  const tenantsRoot = join(dataRoot, "tenants");
  if (!pathExists(tenantsRoot)) return roots.sort();
  safeExistingDirectory(tenantsRoot, "Tenants root");
  for (const tenant of directoryEntries(tenantsRoot)) {
    if (tenant.isSymbolicLink()) fail(`Tenant root must not be a symbolic link: ${tenant.name}`);
    if (!tenant.isDirectory()) continue;
    const tenantRoot = safeExistingDirectory(join(tenantsRoot, tenant.name), "Tenant root");
    const usersRoot = join(tenantRoot, "users");
    if (!pathExists(usersRoot)) continue;
    safeExistingDirectory(usersRoot, "Tenant users root");
    for (const user of directoryEntries(usersRoot)) {
      if (user.isSymbolicLink()) fail(`Tenant user root must not be a symbolic link: ${user.name}`);
      if (user.isDirectory()) {
        roots.push(safeExistingDirectory(join(usersRoot, user.name), "Tenant user root"));
      }
    }
  }
  return [...new Set(roots)].sort();
}

function walkSkill(skillRoot) {
  const files = [];
  let bytes = 0;
  function walk(current, relativePath) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const nextRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (!entry.name || entry.name === "." || entry.name === ".." || /[\0\r\n]/.test(entry.name)) {
        fail(`Unsafe skill path: ${nextRelative}`);
      }
      const path = join(current, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) fail(`Skill contains a symbolic link: ${nextRelative}`);
      if (entry.isDirectory()) {
        walk(path, nextRelative);
        continue;
      }
      if (!entry.isFile() || info.nlink !== 1) {
        fail(`Skill contains a non-regular or hard-linked file: ${nextRelative}`);
      }
      if (SECRET_FILE.test(nextRelative)) fail(`Skill contains forbidden secret material: ${nextRelative}`);
      if (info.size > MAX_FILE_BYTES) fail(`Skill file exceeds ${MAX_FILE_BYTES} bytes: ${nextRelative}`);
      bytes += info.size;
      if (bytes > MAX_SKILL_BYTES) fail(`Skill exceeds ${MAX_SKILL_BYTES} bytes: ${skillRoot}`);
      if (files.length >= MAX_FILES_PER_SKILL) {
        fail(`Skill contains more than ${MAX_FILES_PER_SKILL} files: ${skillRoot}`);
      }
      const content = readFileSync(path);
      let text;
      try {
        text = decoder.decode(content);
      } catch {
        fail(`Skill file is not valid UTF-8: ${nextRelative}`);
      }
      files.push({
        path: nextRelative,
        source: path,
        content,
        executable: (info.mode & 0o111) !== 0,
      });
      if (WARNING_CONTENT.test(text)) {
        process.stderr.write(`[pi-reset] warning: review skill content ${join(skillRoot, nextRelative)}\n`);
      }
    }
  }
  walk(skillRoot, "");
  if (!files.some((file) => file.path.toLowerCase() === "skill.md")) {
    fail(`Skill is missing its root SKILL.md: ${skillRoot}`);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function sameFiles(first, secondRoot) {
  const second = walkSkill(secondRoot);
  if (first.length !== second.length) return false;
  return first.every(
    (file, index) =>
      file.path === second[index].path &&
      Buffer.compare(file.content, second[index].content) === 0 &&
      file.executable === second[index].executable,
  );
}

const users = discoverUserRoots();
const migrations = new Map();
let skillCount = 0;
for (const userRoot of users) {
  const sources = [
    join(userRoot, "claude-config-source", "skills"),
    join(userRoot, ".claude", "skills"),
    join(userRoot, "profile", "claude-config-source", "skills"),
    join(userRoot, "profile", "legacy-claude-config-source", "skills"),
  ];
  for (const source of sources) {
    if (!pathExists(source)) continue;
    safeExistingDirectory(source, "Legacy skills root", userRoot);
    for (const entry of directoryEntries(source)) {
      if (entry.isSymbolicLink()) fail(`Skill root must not be a symbolic link: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      if (!SAFE_NAME.test(entry.name) || entry.name === "." || entry.name === "..") {
        fail(`Unsafe skill name: ${entry.name}`);
      }
      skillCount += 1;
      if (skillCount > MAX_SKILLS) fail(`More than ${MAX_SKILLS} legacy skills were found.`);
      const sourceSkill = safeExistingDirectory(
        join(source, entry.name),
        "Legacy skill",
        userRoot,
      );
      const files = walkSkill(sourceSkill);
      const target = join(userRoot, "pi-resources", "skills", entry.name);
      assertCanonicalPath(target, "Managed Pi skill target", userRoot);
      const key = target;
      const existing = migrations.get(key);
      if (existing) {
        if (
          existing.files.length !== files.length ||
          existing.files.some(
            (file, index) =>
              file.path !== files[index].path ||
              Buffer.compare(file.content, files[index].content) !== 0 ||
              file.executable !== files[index].executable,
          )
        ) {
          fail(`Conflicting legacy skill sources target: ${target}`);
        }
        continue;
      }
      if (pathExists(target)) {
        safeExistingDirectory(target, "Managed Pi skill", userRoot);
        if (!sameFiles(files, target)) fail(`Managed Pi skill conflicts with legacy source: ${target}`);
      }
      migrations.set(key, {
        userRoot,
        sourceSkill,
        target,
        files,
        alreadyPresent: pathExists(target),
      });
    }
  }
}

function sessionCandidate(path) {
  const markers = [
    "session.json",
    "workspace",
    "home",
    "tmp",
    "claude-config",
    "pi-config",
    "pi-sessions",
    "recordings",
    "history",
    "checkouts",
    "user-space-checkouts",
  ];
  for (const marker of markers) {
    const markerPath = join(path, marker);
    if (!pathExists(markerPath)) continue;
    const info = lstatSync(markerPath);
    if (info.isSymbolicLink()) {
      fail(`Session marker must not be a symbolic link: ${markerPath}`);
    }
    return true;
  }
  return false;
}

const deletionTargets = new Set();
const stateRewrites = [];
function addDeletion(path) {
  if (!pathExists(path)) return;
  const requested = assertCanonicalPath(path, "Reset target");
  const info = lstatSync(requested);
  if (info.isSymbolicLink()) fail(`Reset target must not be a symbolic link: ${path}`);
  const canonical = realpathSync(requested);
  if (canonical !== requested || !inside(dataRoot, canonical) || canonical === dataRoot) {
    fail(`Reset target is unsafe: ${path}`);
  }
  deletionTargets.add(requested);
}

function parseWorkspaceState(path) {
  if (!pathExists(path)) return;
  assertCanonicalPath(path, "Workspace state");
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) {
    fail(`Workspace state is not a bounded regular file: ${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`Workspace state is invalid JSON: ${path}`);
  }
  const envelope =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Number.isInteger(parsed.schemaVersion) &&
    Number(parsed.schemaVersion) > 0 &&
    Number.isInteger(parsed.revision) &&
    Number(parsed.revision) >= 0 &&
    typeof parsed.updatedAt === "string" &&
    Object.prototype.hasOwnProperty.call(parsed, "data");
  const envelopeLike =
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    ["schemaVersion", "revision", "data"].some((key) =>
      Object.prototype.hasOwnProperty.call(parsed, key),
    );
  if (envelopeLike && !envelope) {
    fail(`Workspace state has a malformed atomic JSON envelope: ${path}`);
  }
  const state = envelope ? parsed.data : parsed;
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    fail(`Workspace state has an invalid shape: ${path}`);
  }
  const nextState = {
    ...state,
    currentSessionId: null,
    agentSessionIds: {},
    agentSessionHistoryIds: {},
    updatedAt: new Date().toISOString(),
  };
  const next = envelope
    ? {
        ...parsed,
        revision: parsed.revision + 1,
        updatedAt: new Date().toISOString(),
        data: nextState,
      }
    : nextState;
  stateRewrites.push({ path, bytes: `${JSON.stringify(next, null, 2)}\n` });
}

for (const userRoot of users) {
  parseWorkspaceState(join(userRoot, "workspace-state.json"));
  for (const entry of directoryEntries(userRoot)) {
    if (entry.isSymbolicLink()) {
      const possibleSession = SAFE_SESSION_NAME.test(entry.name);
      if (possibleSession) fail(`User child must not be a symbolic link: ${join(userRoot, entry.name)}`);
      continue;
    }
    if (entry.isDirectory() && sessionCandidate(join(userRoot, entry.name))) {
      if (!SAFE_SESSION_NAME.test(entry.name)) {
        fail(`Unsafe legacy session directory name: ${join(userRoot, entry.name)}`);
      }
      addDeletion(join(userRoot, entry.name));
    }
  }
  addDeletion(join(userRoot, "sessions"));
  for (const name of ["launcher.json", "session-names.json"]) {
    for (const entry of directoryEntries(userRoot)) {
      if (
        entry.name === name ||
        entry.name.startsWith(`${name}.`) ||
        entry.name.startsWith(`.${name}.`)
      ) {
        addDeletion(join(userRoot, entry.name));
      }
    }
  }
  for (const path of [
    join(userRoot, "claude-config-source"),
    join(userRoot, ".claude"),
    join(userRoot, "profile", "claude-config-source"),
    join(userRoot, "profile", "legacy-claude-config-source"),
    join(userRoot, "profile", "claude-config-source-v2.json"),
  ]) {
    addDeletion(path);
  }
}

const runtimeDir = join(dataRoot, ".runtime");
if (pathExists(runtimeDir)) {
  safeExistingDirectory(runtimeDir, "Runtime directory");
  for (const entry of directoryEntries(runtimeDir)) {
    if (
      entry.name === "runtime-layout.json" ||
      entry.name === "sdk-bypass.key" ||
      entry.name === "sdk-bypass.crt" ||
      entry.name.startsWith(".sdk-bypass-") ||
      entry.name.startsWith("ccrv2-") ||
      entry.name.startsWith("claude-")
    ) {
      addDeletion(join(runtimeDir, entry.name));
    }
  }
}

for (const migration of migrations.values()) {
  process.stdout.write(
    `[pi-reset] ${migration.alreadyPresent ? "keep" : "migrate"} skill: ` +
      `${relative(dataRoot, migration.sourceSkill)} -> ${relative(dataRoot, migration.target)}\n`,
  );
}
for (const target of [...deletionTargets].sort()) {
  process.stdout.write(`[pi-reset] delete: ${relative(dataRoot, target)}\n`);
}
for (const rewrite of stateRewrites) {
  process.stdout.write(`[pi-reset] clear session references: ${relative(dataRoot, rewrite.path)}\n`);
}

if (!apply) {
  process.stdout.write(
    `[pi-reset] dry-run complete: ${migrations.size} skill(s), ${deletionTargets.size} deletion(s), ` +
      `${stateRewrites.length} state rewrite(s). Set CONFIRM_PI_SESSION_RESET=1 to apply.\n`,
  );
  process.exit(0);
}

assertCanonicalPath(dataRoot, "Data root", dataRoot);
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
safeExistingDirectory(dataRoot, "Data root", dataRoot);
chmodSync(dataRoot, 0o700);

function atomicWrite(path, bytes, mode = 0o600) {
  assertCanonicalPath(dirname(path), "Atomic write directory");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  safeExistingDirectory(dirname(path), "Atomic write directory");
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", mode);
    writeFileSync(fd, bytes);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, mode);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

function ensurePrivateDirectory(path, scope, label) {
  const requested = assertCanonicalPath(path, label, scope);
  if (!pathExists(requested)) mkdirSync(requested, { mode: 0o700 });
  const canonical = safeExistingDirectory(requested, label, scope);
  chmodSync(canonical, 0o700);
  return canonical;
}

for (const migration of migrations.values()) {
  if (migration.alreadyPresent) {
    const existing = safeExistingDirectory(
      migration.target,
      "Managed Pi skill",
      migration.userRoot,
    );
    if (!sameFiles(migration.files, existing)) {
      fail(`Managed Pi skill changed after validation: ${migration.target}`);
    }
    continue;
  }
  const resourcesRoot = ensurePrivateDirectory(
    join(migration.userRoot, "pi-resources"),
    migration.userRoot,
    "Managed Pi resources root",
  );
  const skillsRoot = ensurePrivateDirectory(
    join(resourcesRoot, "skills"),
    migration.userRoot,
    "Managed Pi skills root",
  );
  assertCanonicalPath(migration.target, "Managed Pi skill target", migration.userRoot);
  if (pathExists(migration.target)) {
    fail(`Managed Pi skill target appeared during reset: ${migration.target}`);
  }
  const staged = join(skillsRoot, `.${basename(migration.target)}.${randomUUID()}.tmp`);
  mkdirSync(staged, { mode: 0o700 });
  try {
    for (const file of migration.files) {
      const destination = join(staged, ...file.path.split("/"));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, file.content, {
        flag: "wx",
        mode: file.executable ? 0o700 : 0o600,
      });
    }
    renameSync(staged, migration.target);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

for (const rewrite of stateRewrites) {
  assertCanonicalPath(rewrite.path, "Workspace state");
  const info = lstatSync(rewrite.path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    fail(`Workspace state changed after validation: ${rewrite.path}`);
  }
  atomicWrite(rewrite.path, rewrite.bytes);
}
for (const target of [...deletionTargets].sort((a, b) => b.length - a.length)) {
  assertCanonicalPath(target, "Reset target");
  const info = lstatSync(target);
  if (info.isSymbolicLink() || realpathSync(target) !== target) {
    fail(`Reset target changed after validation: ${target}`);
  }
  rmSync(target, { recursive: true, force: true });
}

ensurePrivateDirectory(runtimeDir, dataRoot, "Runtime directory");
const marker = {
  format: "piwork-runtime-layout",
  version: 1,
  backend: "pi",
  createdAt: new Date().toISOString(),
};
atomicWrite(join(runtimeDir, "runtime-layout.json"), `${JSON.stringify(marker, null, 2)}\n`);
process.stdout.write(
  `[pi-reset] reset complete: migrated ${migrations.size} skill(s), removed ${deletionTargets.size} legacy path(s).\n`,
);
NODE

#!/usr/local/bin/node

const { spawnSync } = require("node:child_process");
const { closeSync, constants, lstatSync, openSync, realpathSync, unlinkSync } = require("node:fs");
const { basename, dirname, isAbsolute, resolve } = require("node:path");

const input = process.argv.slice(2);
const args = [];
const deferredNetworkBinds = [];
const createdMaskDestinations = [];
const srtRuntimeEtcSelfBindPaths = new Set([
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/nsswitch.conf",
  "/etc/gai.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/ld.so.cache",
]);

function isSrtNetworkSocketPath(value) {
  return /^\/tmp\/claude-(?:http|socks)-[^/]+\.sock$/u.test(value);
}

function isRedundantSelfBindPath(value) {
  return /^\/dev\//u.test(value) || srtRuntimeEtcSelfBindPaths.has(value);
}

function openRealMaskParent(destination) {
  if (!isAbsolute(destination) || destination !== resolve(destination)) return;
  const parent = dirname(destination);
  try {
    if (realpathSync(parent) !== parent) return;
  } catch {
    return;
  }

  // Check the canonical spelling first, then reopen every component through
  // a directory fd. This keeps a concurrent parent symlink replacement from
  // redirecting the create outside the path SRT canonicalized.
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let parentFd;
  try {
    parentFd = openSync("/", directoryFlags | constants.O_CLOEXEC);
    let currentPath = "/";
    for (const component of parent.split("/").filter(Boolean)) {
      const componentPath = currentPath === "/" ? `/${component}` : `${currentPath}/${component}`;
      const info = lstatSync(componentPath);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        closeSync(parentFd);
        return;
      }
      const nextFd = openSync(`/proc/self/fd/${parentFd}/${component}`, directoryFlags | constants.O_CLOEXEC);
      closeSync(parentFd);
      parentFd = nextFd;
      currentPath = componentPath;
    }
    return parentFd;
  } catch {
    if (parentFd !== undefined) closeSync(parentFd);
    return;
  }
}

function prepareMissingMaskDestination(destination) {
  let info;
  try {
    info = lstatSync(destination);
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    const parentFd = openRealMaskParent(destination);
    if (parentFd === undefined) return;
    let fd;
    try {
      // O_EXCL + O_NOFOLLOW makes the leaf create race-safe and never follows
      // a symlink that appeared after the parent checks.
      fd = openSync(
        `/proc/self/fd/${parentFd}/${basename(destination)}`,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_CLOEXEC,
        0o600,
      );
    } catch (openError) {
      closeSync(parentFd);
      if (openError && typeof openError === "object" && openError.code === "EEXIST") return;
      return;
    }
    closeSync(fd);
    closeSync(parentFd);
    createdMaskDestinations.push(destination);
    return;
  }
  if (info.isDirectory() || info.isSymbolicLink()) return;
}

function cleanupCreatedMaskDestinations() {
  for (const destination of createdMaskDestinations.reverse()) {
    try {
      const info = lstatSync(destination);
      if (info.isFile() && info.size === 0) unlinkSync(destination);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`piwork-bwrap: mask cleanup deferred for ${destination}: ${message}\n`);
    }
  }
}

for (let index = 0; index < input.length; index += 1) {
  if (
    input[index] === "--ro-bind" &&
    input[index + 1] === input[index + 2] &&
    isRedundantSelfBindPath(input[index + 1])
  ) {
    // The replacement for SRT's --dev /dev already exposes immutable device
    // nodes. SRT's system runtime allow-read list contains these exact /etc
    // paths; rebinding any of them to itself makes bwrap recreate a mount point
    // inside the nested namespace, which is denied by the capability-free
    // Compose boundary on some kernels. Keep ordinary masks (for example
    // --ro-bind /dev/null <workspace-file>) untouched.
    index += 2;
    continue;
  }
  if (
    input[index] === "--ro-bind" &&
    input[index + 1] === "/dev/null" &&
    input[index + 2] !== "/dev/null" &&
    !/^\/dev\//u.test(input[index + 2])
  ) {
    // Bubblewrap creates a missing --ro-bind destination with creat(2) after
    // applying the earlier root/tmpfs mounts. In a nested capability-free
    // namespace that path can be read-only even when its final workspace bind
    // is writable, so pre-create only the missing regular file on the host.
    // Keep SRT's /dev/null source and deny mount unchanged; never manufacture
    // parents or follow symlinks.
    prepareMissingMaskDestination(input[index + 2]);
    args.push(input[index], input[index + 1], input[index + 2]);
    index += 2;
    continue;
  }
  if (
    input[index] === "--bind" &&
    isSrtNetworkSocketPath(input[index + 1]) &&
    input[index + 1] === input[index + 2]
  ) {
    deferredNetworkBinds.push(input[index], input[index + 1], input[index + 2]);
    index += 2;
    continue;
  }
  if (input[index] === "--dev" && input[index + 1] === "/dev") {
    args.push("--ro-bind", "/dev", "/dev");
    index += 1;
  } else {
    args.push(input[index]);
  }
}

// SRT's filesystem policy mounts a read-only root and then a tmpfs over /tmp.
// Keep its host-side proxy sockets visible by applying their file binds after
// those mounts have been constructed. The paths are generated by SRT itself;
// no user-controlled bind is reordered.
const commandIndex = args.indexOf("--");
if (commandIndex === -1) {
  process.stderr.write("piwork-bwrap: missing command separator\n");
  process.exit(2);
}
args.splice(commandIndex, 0, ...deferredNetworkBinds);

let result;
try {
  result = spawnSync("/usr/bin/bwrap", args, { stdio: "inherit" });
} finally {
  cleanupCreatedMaskDestinations();
}
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(127);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
  process.exit(128);
}
process.exit(result.status ?? 1);

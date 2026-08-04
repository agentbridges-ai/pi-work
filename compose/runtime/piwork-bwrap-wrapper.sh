#!/bin/bash
set -euo pipefail

# sandbox-runtime always asks bubblewrap to create a fresh /dev tree.  A
# capability-free Docker runtime cannot create device nodes on every host
# kernel, even when the outer container has a private /dev.  Compose's
# explicitly typed nested mode can safely reuse that private device tree as a
# read-only bind instead.  Do not use this wrapper for native Linux SRT, where
# sandbox-runtime's strict --dev boundary remains required.
args=()
while (($# > 0)); do
  if [[ "$1" == "--dev" && "${2-}" == "/dev" ]]; then
    args+=(--ro-bind /dev /dev)
    shift 2
  else
    args+=("$1")
    shift
  fi
done

exec /usr/bin/bwrap "${args[@]}"

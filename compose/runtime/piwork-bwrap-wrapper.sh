#!/bin/sh
set -eu

# sandbox-runtime always asks bubblewrap to create a fresh /dev tree.  A
# capability-free Docker runtime cannot create device nodes on every host
# kernel, even when the outer container has a private /dev.  Compose's
# explicitly typed nested mode can safely reuse that private device tree as a
# read-only bind instead.  Do not use this wrapper for native Linux SRT, where
# sandbox-runtime's strict --dev boundary remains required.
# Keep this helper POSIX-only: a Bash wrapper can try to initialize job control
# before bubblewrap creates its nested PID namespace on some host kernels.
# Null-delimited xargs preserves every argv item, including paths with spaces.
set +e
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--dev" ] && [ "${2-}" = "/dev" ]; then
    printf '%s\0' "--ro-bind" "/dev" "/dev"
    shift 2
  else
    printf '%s\0' "$1"
    shift
  fi
done | xargs -0 -r /usr/bin/bwrap
status=$?
set -e
exit "$status"

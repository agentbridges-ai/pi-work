# Review Focus
Prioritize bugs, protocol regressions, state-loss risks, security flaws, and missing tests tied to changed behavior.
Avoid style-only nitpicks unless they hide correctness issues.

# Backend Testing
@scope web/server/**/*.ts
For backend behavior changes, require matching Vitest coverage in `web/server/*.test.ts` for success paths, failure paths, and edge cases.

# Frontend Testing
@scope web/src/**/*.ts web/src/**/*.tsx
For frontend behavior changes, require matching tests in `web/src/**/*.test.ts(x)` and avoid introducing client/server type drift.

# Pi WebSocket Contract Safety
@scope web/shared/pi-browser-protocol.ts web/server/ws-bridge.ts web/src/ws.ts web/src/store.ts
Treat the Pi-only browser message shapes, sequence/ack/replay semantics, generation fences, and reconnect behavior as a strict contract. Flag any alternate or compatibility protocol.

# Session Persistence and Reset
@scope web/server/session-store.ts web/server/pi-session-history.ts web/server/pi-launcher.ts web/server/ws-bridge.ts scripts/pi-reset-legacy-sessions.sh
Pi JSONL is the sole durable conversation/model/compaction/Plan/Todo authority. `session.json` may contain only product authority, archival state, the relative Pi path, offline delivery, and client deduplication. Legacy session data must fail closed until the explicit reset command runs.

# Security Baseline
@scope web/server/routes.ts web/server/pi-*.ts web/server/path-resolver.ts web/server/srt-policy.ts
Flag credential material in argv, files, environment, logs, recordings, or Pi JSONL; command injection; path traversal; unsafe shell interpolation; generation confusion; reusable capabilities; or unvalidated filesystem writes. Require exact package pins, one-use Unix-socket bootstrap, explicit allowlists, path normalization, and argument-array process spawning.

# Native Pi Runtime
@scope web/server/**/*.ts web/src/**/*.ts web/src/**/*.tsx
Only `@earendil-works/pi-coding-agent@0.82.1` native `rpc-entry` through one per-session SRT child is supported. Flag alternate Agent backends, compatibility adapters, SDK proxy URLs, binary/config discovery, workspace Pi discovery, package installation, or login paths.

# Additional Context
@scope web/server/**/*.ts
The backend bridges browser WebSockets to strict LF-delimited Pi RPC. Correlation ids, fragmented/coalesced frames, backpressure, limits, timeout/abort, process generation, readiness, reconnection, and Pi JSONL history safety are critical.

@scope web/src/**/*.tsx web/src/**/*.ts
Frontend uses Zustand state keyed by session ID and relies on typed WebSocket events. Review for stale state, race conditions, and multi-session bleed-through.

@scope web/server/pi-rpc-contract.ts web/server/pi-rpc-transport.ts web/server/pi-readiness.ts
Protocol validation represents the pinned native Pi contract. Prioritize framing, schema drift, lifecycle cleanup, and adapter safety over formatting concerns.

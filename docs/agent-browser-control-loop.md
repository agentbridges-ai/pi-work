# Agent browser control loop

This document defines the first deliverable Mac browser-control architecture. It is a control-plane contract, not a claim that the macOS development process is sandboxed.

## Fixed route

The supported route is:

```text
Piwork session
  -> native Pi through strict JSONL RPC
  -> session-owned agent-browser wrapper
  -> pinned chrome-extension provider daemon on loopback
  -> MV3 extension
  -> chrome.debugger / CDP
  -> one attached Chromium tab
```

The first Mac release is structured/CDP-first. CUA, coordinate clicks, raw CDP fallback, and a cloud browser-control relay are outside this contract.

## Control-system model

The controlled plant is the attached page. Structured browser commands are actuators; CDP events are change signals; fresh semantic snapshots are the measurement channel. A command acknowledgement does not prove a business outcome. Every write turn remains `observe -> act -> observe -> verify`, with the post-action semantic read deciding what happened.

Control ownership is a separate loop:

```text
agent --takeover/epoch+1--> human --summary + fresh snapshot/epoch+1--> agent
   \-------------------------- stop/epoch+1 ------------------------> stopped
```

Each transition is persisted crash-safely in the session directory. The epoch is raised before interruption so stale dispatches fail closed. The session wrapper checks the persisted phase before every new CLI invocation, while the provider daemon fences already-connected CDP traffic. The two fences cover different race windows and are both required.

## Ownership semantics

- `agent`: structured browser commands may be dispatched.
- `takeover_pending`: the epoch has changed; interruption is in progress.
- `human`: provider and wrapper reject Agent browser writes. The page shows that the user owns control.
- `resuming`: a non-empty handoff summary is being delivered to Pi.
- `stopping`: interruption and provider cleanup are in progress.
- `stopped`: the bridge session is detached and future browser commands are rejected.
- `uncertain`: interruption, handoff delivery, or cleanup could not be confirmed. The UI must show the risk instead of assuming success.

Takeover cancels queued provider requests. A CDP command already accepted by Chrome may still have completed, so the provider reports `pendingActionRisk`; Piwork preserves that uncertainty and requires a fresh snapshot after resume.

## Page boundary and control paths

The extension injects a visible blue page boundary and a bottom operator bar only after a provider session attaches the tab. It exposes `Take over` and `Stop`; resume stays in Piwork because the handoff summary must enter the authenticated session context.

Page intent travels back through the existing loopback bridge as a typed control event. The daemon maps the event to an opaque `nex-<hash>` owner ID, never the Better Auth identity or raw Piwork session ID. Piwork consumes a bounded event queue, resolves the owner locally, updates the authoritative session state, aborts the current Pi generation, and synchronizes provider state. Browser status APIs continue to omit tab URLs, titles, page content, bridge tokens, and handoff text.

The overlay is a product boundary, not a security boundary: page script can hide DOM. Enforcement lives in the wrapper and daemon fences.

## Lifecycle and recovery

- Session kill, archive, delete, user/tenant revocation, runtime disposal, panel Stop, page Stop, tab close, and debugger detach all converge on provider stop/detach.
- Provider events are bounded to 256 entries. Piwork polls at 250 ms while reachable and backs off to 2 seconds while offline; the timer is unref'd and cancelled on disposal.
- Extension reconnect resynchronizes overlays for attached sessions. Navigation reinjects the page boundary, and the next structured command also repairs it.
- Daemon shutdown cancels pending timeouts, closes CDP clients and extension peers, and performs best-effort overlay/detach notifications without waiting on an offline extension.
- Resume is accepted only after the provider returns control, Piwork captures a fresh structured snapshot through the owned session, and the handoff plus that snapshot are delivered to the current Pi RPC generation. The persisted phase remains `resuming`, so the agent-facing wrapper rejects concurrent commands throughout this measurement window. Any missing provider session, failed readback, failed RPC delivery, or failed handoff makes the state `uncertain` and returns provider control to the user.

## Verification obligations

The release is not complete on unit coverage alone. The minimum evidence chain is:

1. Provider protocol tests: token validation, owner binding, takeover fence, resume, stop, bounded events, detach cleanup.
2. Piwork tests: persistent state/epoch, risk propagation, authenticated routes, UI takeover-summary-resume-stop flow, bridge event polling and timer disposal.
3. Fixed-toolchain `make verify`.
4. Real Mac Chrome E2E with the pinned unpacked extension: attach, semantic read, write and readback, visible boundary, takeover fence, summary resume, stop, tab-close cleanup, extension reconnect, and no CUA fallback.

There is no unsandboxed macOS Agent escape hatch. Production, multi-user, and
development Pi session execution all require the enforced Linux SRT path.

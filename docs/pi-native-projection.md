# Native Pi projection contract

Piwork renders native Pi as a paper-work task surface. The browser is a
projection of Pi JSONL plus explicitly versioned Piwork trusted-extension
events; it is never a second authority for transcript, model, mode, Plan,
Todo, or task identity.

**Status.** This is an implementation contract for the native-Pi projection,
not a claim that every listed surface has shipped. It is grounded in the pinned
`@earendil-works/pi-coding-agent` 0.82.1 RPC contract and is deliberately
narrower than the interaction references below. Product behavior belongs to
Piwork only when it can be projected from Pi history/RPC or an explicitly
versioned trusted-extension event.

## Evidence and non-goals

The following sources inform this contract; they do not license importing
another product's runtime or information architecture.

- Pi's pinned [0.82.1 RPC protocol](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/rpc.md)
  is normative for JSONL framing, request correlation, event names, queueing,
  extension UI, retries, and compaction. Its [extension lifecycle
  documentation](https://github.com/earendil-works/pi/blob/v0.82.1/packages/coding-agent/docs/extensions.md#agent_start--agent_end--agent_settled)
  is normative for the distinction between `agent_end` and `agent_settled`.
- Anthropic's official [Cowork guide](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)
  supports an outcome-first handoff, visible approach/progress, mid-task
  steering, parallel work when warranted, and reviewable output. Its remote
  sessions, account-backed state, and deletion-permission model are expressly
  out of scope here.
- OpenAI's official [Codex app introduction](https://openai.com/index/introducing-the-codex-app/)
  and [Codex usage guide](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan.pdf)
  support clear task delegation, progress check-ins, intervention, and review.
  Codex worktrees, Git, sandbox/approval modes, and host-oriented project
  workflows are not Piwork product features.

This keeps the design evidence-led without turning Piwork into an IDE
dashboard or a visual clone of either reference product.

The experience follows one restrained loop:

```text
outcome prompt
  -> visible approach and current work
  -> precise question or approval when needed
  -> reviewable files and verification
  -> agent_settled
```

Claude Cowork and the Codex app are interaction references for delegation,
attention, and review. Their visual systems, cloud/remote execution, Git,
worktree, PTY, broad approval modes, and product-specific state stores are not
Piwork architecture.

## Projection pipeline

All live, restored, and replayed work uses the same one-way pipeline:

```text
Pi 0.82.1 RPC notifications + trusted-extension events
  -> versioned browser domain events
  -> pure activity projector
  -> transcript, activity, task, interaction, and artifact views
```

Projection events have stable correlation keys where the upstream or trusted
extension supplies them:

```text
sessionId -> generation -> turn/item -> message/toolCall/request/task -> seq
```

Live assistant messages use a provisional stream identity. After
`agent_settled`, durable Pi entries reconcile the projection. A provisional
React key must not become a session-entry identity.

## Orthogonal state

Connection state and Agent work state are independent. Do not encode provider
retry as transport reconnect or compaction as a generic busy flag.

| Axis       | Values                                                    | UI purpose                                      |
| ---------- | --------------------------------------------------------- | ----------------------------------------------- |
| connection | `connecting`, `connected`, `reconnecting`, `disconnected` | Whether the browser can reach the session       |
| run        | `starting`, `running`, `settling`, `idle`, `stopped`      | Whether Pi may still continue this turn         |
| operation  | `none`, `retrying`, `compacting`                          | Why the run is temporarily paused or continuing |
| attention  | `none`, `needs_input`, `review_ready`, `blocked`          | Whether user judgment is useful now             |

Only `agent_settled` establishes the native idle boundary. `agent_end`, the
last text delta, a tool result, or a successful prompt acknowledgement does
not.

## Pi event classification

Every Pi 0.82.1 notification is classified. A newly decoded, unclassified
event is a test failure.

| Pi notification                                                | Projection                        | Persistence and rendering                                  |
| -------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| `agent_start`                                                  | run `running`                     | transient status                                           |
| `agent_end`                                                    | run `settling` or operation retry | never declares idle                                        |
| `agent_settled`                                                | run `idle`; reconcile entries     | terminal native boundary                                   |
| `turn_start` / `turn_end`                                      | turn boundary                     | correlation and diagnostics; compact by default            |
| user `message_start/end`                                       | accepted user message only        | do not publish a second user bubble                        |
| assistant `message_start/update/end`                           | one assistant item                | replace cumulative snapshots; final entry is authoritative |
| tool-result `message_start/end`                                | join the matching tool item       | never render as a system or user message                   |
| `tool_execution_start/update/end`                              | one tool item by `toolCallId`     | cumulative progress replaces; terminal result completes    |
| `queue_update`                                                 | steer and follow-up snapshots     | separate “next turn” and “after completion” queues         |
| `auto_retry_start/end`                                         | operation `retrying`              | preserve attempt, maximum, delay, and error                |
| `compaction_start/end`                                         | operation `compacting`            | preserve reason, failure, retry, and usage uncertainty     |
| `summarization_retry_scheduled`, `_attempt_start`, `_finished` | compaction retry detail           | diagnostics and expandable status                          |
| `bash_execution_update`                                        | direct-command item               | distinct from an Agent tool call                           |
| `thinking_level_changed`                                       | session state                     | effective value from Pi, not optimistic UI authority       |
| `session_info_changed` / `entry_appended`                      | durable reconciliation signal     | cursor/tree refresh, not a chat bubble                     |
| extension UI request/response                                  | interaction item                  | stable request ID, server-acknowledged lifecycle           |
| extension notify/status/widget/title/editor text               | typed extension projection        | safe renderer registry with generic fallback               |
| `extension_error`                                              | blocked/error item                | actionable, correlated error                               |

The adapter may explicitly ignore an event only when the classification table
and an exhaustive contract test name the reason.

The table is intentionally event- rather than screen-oriented: Pi RPC emits
strict LF-delimited JSONL, and prompt success only means accepted, queued, or
handled—not that later event/message processing succeeded. The projector must
therefore preserve request IDs and render the subsequent event stream rather
than infer completion from a prompt acknowledgement.

## Message and tool invariants

- One accepted prompt produces exactly one user item.
- One `toolCallId` produces exactly one tool item across live, history, replay,
  and reconnect.
- Tool arguments may stream before execution and are shown as preparing, then
  running, then terminal.
- Tool progress and message updates are cumulative snapshots where specified
  by Pi and replace prior snapshots.
- Parallel tools update independently while durable transcript order follows
  Pi entry order.
- Provider failures retain `stopReason` and error text even when assistant
  content is empty.
- Internal managed-task delivery envelopes are input to Pi, not user-authored
  transcript items.

## Product-extension invariants

Plan, Todo, Ask, foreground tasks, and background tasks are Piwork trusted
extension semantics rather than hidden Pi core behavior.

- Plan remains exactly `agent | plan`; Plan is fail-closed.
- Todo is the latest trusted full snapshot on the active Pi branch.
- Ask and Plan decisions use `requested -> submitting -> resolved | error` and
  remain visible until the server accepts the response.
- A task has one stable originating tool-call identity, explicit parent,
  foreground/background execution, status, progress, duration, and summary.
- Child detail is nested under the originating task. The parent transcript
  receives a bounded summary; intermediate child state is durable only when
  the trusted extension explicitly records it.

## Information hierarchy

The default surface answers only:

1. What is Pi doing?
2. Why did it pause?
3. What does the user need to decide?
4. Where is the result?

Detailed thinking summaries, tool input/output, retry metadata, compaction,
child work, raw events, and protocol frames stay progressively disclosed.
Piwork retains its paper canvas, typography, muted colors, thin rules, and
small motion. A contextual side sheet may appear for a Plan or artifact, but
there is no permanent IDE dashboard.

## Projection Lab

The development-only Projection Lab is enabled only with
`PIWORK_RECORDING_HUB=1`. It reuses production events, projector, reducer, and
components; it is not a production demo route or a second state engine.

A versioned scenario contains a logical clock, browser events, scripted user
actions, semantic checkpoints, and optional sanitized recording provenance.
The same scenario drives projector tests, component tests, and Playwright.

The Lab supports play, pause, step, speed, seek, and deterministic injection
of duplicate frames, gaps, stale generations, disconnects, late responses,
cancel races, retry, and compaction. Raw Pi JSONL and protected contents remain
redacted.

## Release gates

- Live, history, and replay converge to the same semantic projection.
- Reconnect at every event boundary produces the same settled view as an
  uninterrupted run.
- No old generation mutates a new session view.
- Settled foreground work has no running tool or unresolved interaction.
- Chinese and English copy, keyboard operation, reduced motion, status
  announcements, responsive layout, and visual regression are covered.
- Deterministic CI uses a fake Pi transport; a small real Pi 0.82.1 conformance
  suite runs separately and contributes sanitized fixtures.

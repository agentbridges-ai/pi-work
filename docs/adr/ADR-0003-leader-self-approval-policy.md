---
owner: Misakago
status: accepted
last_reviewed: 2026-08-06
review_cycle_days: 90
---

# ADR-0003：Leader 作者 self-or-exempt 治理规则

## Context

Piwork 的 Leader/Owner 是 `@Misakago`。GitHub 原生 Team/CODEOWNER reviewer 规则无法按作者区分 Leader、非 Leader Core 和社区贡献者；如果保留 native reviewer count=1，Leader 作者即使获准自审/免审也会被平台阻断。非 Leader Core 作者仍必须获得两名非作者 Core 成员的最新提交审批，社区作者保持一名普通审批。

## Decision

在 `.governance/github-policy.json` 中显式启用 `leaderReviewMode: "self-or-exempt"`，且只有登录名精确等于 `leader` 的 PR 作者适用；该模式把 Leader 的额外治理审批要求设为 0。`leader-review.mjs` 的规则为：

1. 只计算针对当前 head SHA、且每个 reviewer 最新状态仍为 `APPROVED` 的 Review，并去重、排除 PR 作者，避免旧提交、被后续 `CHANGES_REQUESTED` 覆盖或作者 Review 误满足规则。
2. Leader 作者无须额外治理审批即可通过；若 API 已有当前 head 的 Leader self-review，可以在状态描述中显示，但不创建、不伪造 GitHub Review。
3. Leader 对其他所有 PR（包括 Dependabot 等自动化作者）的一次当前-head有效审批可计一票；非 Leader Core 作者需要两名不同、非作者且在 `coreReviewerLogins` allowlist 中的当前 head 审批，初始 allowlist 只有 Leader 时该路径明确 fail-closed；社区作者需要 `ordinaryApprovals`（当前为一名）allowlist 审批。CODEOWNERS 只作为 ownership metadata；主/高风险 Ruleset 使用 native reviewer count=0、空 `required_reviewers` 和 `require_code_owner_review=false`，将 author-aware approval enforcement 委托给 required `governance-review`。
4. 高风险路径仍要求 Leader 参与；Leader 作为作者即满足参与条件，非 Leader 作者则必须有 Leader 针对当前 head 的有效审批，且 Leader 不能是该 head 的 author/committer（最后推送者）。所有非 Leader 作者的普通审批同样排除 head author/committer，防止关闭 native last-push 后出现自推自审。

`pull_request_target` 只从 trusted base checkout 并读取 GitHub PR 元数据，不执行 PR 分支代码；reviewer login 必须命中显式 allowlist，未知身份 fail-closed。PR 编号由 GitHub Actions runner 注入的受验证环境变量提供，并与事件元数据交叉校验。该规则在本 ADR 合入 trusted base 后生效；治理 PR 在规则尚未合入 trusted base 时可能出现受控 no-op。`governance-review` 的 required status 是 0/2/1 条件审批权威；Ruleset 的 native last-push approval 关闭，由该 trusted 状态对需要审批的作者执行 current-head 约束，同时保留签名、线性历史、线程解决和 required checks。Required statuses 绑定 GitHub Actions integration `15368`。不创建或配置 Misaka 专用 bypass actor。仅当非 Leader/社区作者确实无法满足独立成员审批时，才可沿用已登记的、仅 PR 范围的 `piwork-leads` bypass，并记录原因、范围、跟踪 Issue 与复盘期限。

## Alternatives rejected

- 伪造一条 GitHub Review 或创建 Leader 专用 bypass actor：会污染审计记录，也违反 GitHub 的作者自审限制。
- 让所有 Core 作者只需一票：会削弱非 Leader Core 的双人复核要求。
- 在工作流中读取 PR 分支脚本：会让 `pull_request_target` 执行不受信任代码。
- 以任意 GitHub collaborator 或 `author_association` 代替 Core allowlist：无法证明 Team membership，会把未知 reviewer 错误计票。

## Consequences and verification

- Leader 作者的治理状态在没有 Review 时按 `0` 个额外审批通过；已有当前 head self-review 只展示，不改变 CODEOWNERS ownership metadata、签名提交、current-head 约束与必需状态检查。
- `scripts/governance/governance-fixtures.mjs` 覆盖 Leader 无 Review、Leader 有当前 head self-review、非 Leader Core 双审、社区一审、当前 head 去重/排除作者和高风险 Leader 参与。
- `make governance-check` 会验证 `leaderReviewMode: "self-or-exempt"`、reviewer allowlist、native Ruleset reviewer count=0 与 Leader `0` 个额外治理审批。

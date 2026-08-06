---
owner: Misakago
status: accepted
last_reviewed: 2026-08-06
review_cycle_days: 90
---

# ADR-0003：Leader 作者 self-or-exempt 治理规则

## Context

Piwork 的 Leader/Owner 是 `@Misakago`。GitHub 不允许 PR 作者提交自己的 Review，而治理要求需要按作者区分 Leader、非 Leader Core 和社区贡献者。非 Leader Core 作者仍必须获得两名非作者 Core 成员的最新提交审批，社区作者保持一名普通审批。

## Decision

在 `.governance/github-policy.json` 中显式启用 `leaderReviewMode: "self-or-exempt"`，且只有登录名精确等于 `leader` 的 PR 作者适用；该模式把 Leader 的额外治理审批要求设为 0。`leader-review.mjs` 的规则为：

1. 只计算针对当前 head SHA 的 `APPROVED` Review，并去重、排除 PR 作者，避免旧提交或作者 Review 误满足规则。
2. Leader 作者无须额外治理审批即可通过；若 API 已有当前 head 的 Leader self-review，可以在状态描述中显示，但不创建、不伪造 GitHub Review。
3. 非 Leader Core 作者需要两名非作者 Core 审批；社区作者需要 `ordinaryApprovals`（当前为一名）。CODEOWNERS/Ruleset 负责把审批路由到 Core Team，治理脚本只读取 PR 元数据。
4. 高风险路径仍要求 Leader 参与；Leader 作为作者即满足参与条件，非 Leader 作者则必须有 Leader 针对当前 head 的有效审批。

`pull_request_target` 只从 trusted base checkout 并读取 GitHub PR 元数据，不执行 PR 分支代码。该规则在本 ADR 合入 trusted base 后生效；治理 PR 在规则尚未合入 trusted base 时可能出现受控 no-op。GitHub 原生 required review 不能按作者表达 0/2/1，因此 `governance-review` 的策略状态是条件审批权威；不创建或配置 Misaka 专用 bypass actor。仅当非 Leader/社区作者确实无法满足独立成员审批时，才可沿用已登记的、仅 PR 范围的 `piwork-leads` bypass，并记录原因、范围、跟踪 Issue 与复盘期限。

## Alternatives rejected

- 伪造一条 GitHub Review 或创建 Leader 专用 bypass actor：会污染审计记录，也违反 GitHub 的作者自审限制。
- 让所有 Core 作者只需一票：会削弱非 Leader Core 的双人复核要求。
- 在工作流中读取 PR 分支脚本：会让 `pull_request_target` 执行不受信任代码。

## Consequences and verification

- Leader 作者的治理状态在没有 Review 时按 `0` 个额外审批通过；已有当前 head self-review 只展示，不改变 CODEOWNERS、签名提交、最新 push 与必需状态检查。
- `scripts/governance/governance-fixtures.mjs` 覆盖 Leader 无 Review、Leader 有当前 head self-review、非 Leader Core 双审、社区一审、当前 head 去重/排除作者和高风险 Leader 参与。
- `make governance-check` 会验证 `leaderReviewMode: "self-or-exempt"` 与 Leader `0` 个额外治理审批。

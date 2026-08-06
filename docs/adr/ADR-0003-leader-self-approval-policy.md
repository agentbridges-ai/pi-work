---
owner: Misakago
status: accepted
last_reviewed: 2026-08-06
review_cycle_days: 90
---

# ADR-0003：Leader 作者自审计计数规则

## Context

Piwork 的 Leader/Owner 是 `@Misakago`。在 Core Team 仍处于 bootstrap 阶段时，GitHub 不允许 PR 作者提交自己的 Review；因此，Leader 作者的治理检查会一直显示 `0/1`，即使作者已经承担了变更责任。另一方面，非 Leader Core 作者仍必须获得两名非作者 Core 成员的最新提交审批，社区作者保持一名普通审批。

## Decision

在 `.governance/github-policy.json` 中显式启用 `leaderSelfApproval: true`，且只有登录名精确等于 `leader` 的 PR 作者适用。`leader-review.mjs` 的有效审批计数规则为：

1. 只计算针对当前 head SHA 的 `APPROVED` Review，并去重、排除 PR 作者，避免旧提交或作者 Review 误满足规则。
2. Leader 作者身份额外计入一次审计计数，但不创建、不伪造 GitHub Review；状态描述会明确标注这是作者身份计数。
3. 非 Leader Core 作者需要两名非作者 Core 审批；社区作者需要 `ordinaryApprovals`（当前为一名）。CODEOWNERS/Ruleset 负责把审批路由到 Core Team，治理脚本只读取 PR 元数据。
4. 高风险路径仍要求 Leader 参与；Leader 作为作者即满足参与条件，非 Leader 作者则必须有 Leader 针对当前 head 的有效审批。

`pull_request_target` 只从 trusted base checkout 并读取 GitHub PR 元数据，不执行 PR 分支代码。该规则在本 ADR 合入 trusted base 后生效；治理 PR 在规则尚未合入 trusted base 时可能出现受控 no-op。若 bootstrap 阶段无法满足独立成员审批，只能沿用已登记的、仅 PR 范围的 `piwork-leads` bypass，并记录原因、范围、跟踪 Issue 与复盘期限。

## Alternatives rejected

- 伪造一条 GitHub Review：会污染审计记录，也违反 GitHub 的作者自审限制。
- 让所有 Core 作者只需一票：会削弱非 Leader Core 的双人复核要求。
- 在工作流中读取 PR 分支脚本：会让 `pull_request_target` 执行不受信任代码。

## Consequences and verification

- Leader 作者的治理状态可在没有自审 Review 的情况下达到 `1/1`，但不改变 CODEOWNERS、签名提交、最新 push 与必需状态检查。
- `scripts/governance/governance-fixtures.mjs` 覆盖 Leader 自审计、非 Leader Core 双审、社区一审、当前 head 去重/排除作者和高风险 Leader 参与。
- `make governance-check` 会验证 `leaderSelfApproval` 是显式且开启的策略字段。

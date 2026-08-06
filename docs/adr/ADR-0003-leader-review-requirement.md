---
owner: Misakago
status: accepted
last_reviewed: 2026-08-06
review_cycle_days: 90
---

# ADR-0003：所有作者的独立审批要求

## Context

Piwork 的 Leader/Owner 是 `@Misakago`。GitHub 不允许 PR 作者提交自己的 Review，因此每个 PR 都必须有独立于作者的当前 head 审批。作者类别只影响所需审批数量：普通作者（含社区贡献者）一票，Leader 作者一票，非 Leader Core 作者两票。

## Decision

在 `.governance/github-policy.json` 中显式设置 `leaderReviewMode: "required"` 和 `leaderApprovals: 1`。`leader-review.mjs` 的规则为：

1. 只计算针对当前 head SHA 的 `APPROVED` Review，并去重、排除 PR 作者，避免旧提交或作者 Review 误满足规则。
2. Leader 作者必须获得一名独立的当前 head 审批；Leader 自身的 Review（即使 API 返回）不计入，也不创建、不伪造 GitHub Review。
3. 非 Leader Core 作者需要两名非作者 Core 审批；普通作者和社区作者需要 `ordinaryApprovals`（当前为一名）。CODEOWNERS/Ruleset 负责把审批路由到 Core Team，治理脚本只读取 PR 元数据。
4. 高风险路径仍要求 Leader 参与；Leader 作为作者即满足参与条件，非 Leader 作者则必须有 Leader 针对当前 head 的有效审批。

`pull_request_target` 只从 trusted base checkout 并读取 GitHub PR 元数据，不执行 PR 分支代码。该规则在本 ADR 合入 trusted base 后生效；治理 PR 在规则尚未合入 trusted base 时可能出现受控 no-op。GitHub 原生 required review 不能按作者表达 1/2 的差异时，`governance-review` 负责确认独立审批数量；它不得把作者 Review 当作批准，也不得创建或配置 Misaka 专用 bypass actor。历史 PR-only bootstrap 记录仅用于审计；任何紧急例外都必须是已登记、仅 PR 范围、有期限的通用流程，不构成作者免审。

## Alternatives rejected

- 伪造一条 GitHub Review、把作者 Review 计入审批或创建 Leader 专用 bypass actor：会污染审计记录，也违反 GitHub 的作者自审限制。
- 让所有 Core 作者只需一票：会削弱非 Leader Core 的双人复核要求。
- 在工作流中读取 PR 分支脚本：会让 `pull_request_target` 执行不受信任代码。

## Consequences and verification

- Leader 作者没有独立 Review 时失败；只有一名独立当前 head 审批才通过，作者自己的 Review 永远不计入。
- `scripts/governance/governance-fixtures.mjs` 覆盖 Leader 无 Review、Leader 仅自审、Leader 一票独立审批、非 Leader Core 双审、社区一审、当前 head 去重/排除作者和高风险 Leader 参与。
- `make governance-check` 会验证 `leaderReviewMode: "required"`、普通作者/Leader 各一票和非 Leader Core 两票。

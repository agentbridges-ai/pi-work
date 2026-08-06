---
owner: Misakago
status: accepted
last_reviewed: 2026-08-06
review_cycle_days: 90
---

# ADR-0005：由 governance-review 承担作者感知审批，Ruleset 保留安全门禁

## Context

GitHub Ruleset 的 Team/CODEOWNER required reviewer 只能表达固定数量，无法同时满足
Leader 作者 0、非 Leader Core 2、社区 1 和 Dependabot 低风险 1（必须 Leader）四种
作者条件。固定 Team reviewer 会在 Leader 合法自审/免审的 PR 上产生 `REVIEW_REQUIRED`，
而移除审批状态又会把未知 reviewer 错误计票。

## Decision

主分支和高风险 Ruleset 的 native pull-request 参数采用 `required_approving_review_count: 0`、
`required_reviewers: []`、`require_code_owner_review: false`，避免原生 Team/CODEOWNER
审批阻断作者感知规则。`governance-review` 作为 required status，由 trusted
`pull_request_target` 从 base 脚本读取 PR 元数据、current-head reviews、文件范围和
`.governance/github-policy.json` 的 `coreReviewerLogins` allowlist，fail-closed 计算：

- Leader 作者：0 个额外审批，当前 head self-review 可显示但不是伪造的 Review；
- 其他 PR（包括 Dependabot 等自动化作者）：`Misakago` 对当前 head 的有效审批计一票且每个 PR 只计一次；低风险 Dependabot 仍需 Leader 不是实际最后 push 者；
- 非 Leader Core 作者：2 个不同、非作者且在 allowlist 中的当前 head 审批；初始 allowlist 只有 Leader 时该路径明确 fail-closed，待 Leader 登记至少两名 Core 身份；
- 社区作者：1 个 allowlist 中的当前 head 审批；scope 不合规则的 Dependabot 回退普通/高风险规则。

CODEOWNERS 保留为 ownership metadata 和评审路由提示，不作为 native merge gate。Ruleset
继续强制签名提交、线性历史、线程解决、required checks、删除/force-push 保护；native
`require_last_push_approval` 关闭，由 `governance-review` 对需要审批的作者执行
current-head 和实际最后 push 者排除约束，从而允许 Leader self-or-exempt。实际最后 push 者优先来自绑定当前 `repository + PR number + headRef` 的 v2 compact `governance-review-pusher` commit status，否则来自匹配当前 head/分支的 head 仓库 `PushEvent` actor；旧格式、超长、跨 PR/分支记录和 PR `opened` opener 不被接受，无法读取时 fail-closed。trusted workflow 固定从 main 执行并拒绝 PR workflow 增加 status-writing permission；仓库 Actions 默认权限和批准 PR 设置由管理员治理工具 readback。每个 required status 绑定 GitHub Actions
integration `15368`，避免任意写权限凭据伪造治理状态。`governance-review` 缺失、allowlist
漂移、未知 reviewer 或过期 head 均失败。
`piwork-leads` 仍只能使用已登记的 PR-only bypass，不能静默直推或跳过 required status。

## Alternatives rejected

- 保留 native Core Team reviewer：会阻断 Leader 作者合法 self-or-exempt PR。
- 按 `author_association` 或任意 collaborator 计作 Core：无法证明 Team membership，违反 fail-closed。
- 允许 workflow 读取 PR 分支治理脚本：会让 `pull_request_target` 执行不受信任代码。

## Verification

`.governance/github-policy.json`、`check-governance.mjs` 和 `github-governance.mjs` 对 native
reviewer count/Team/CODEOWNER 漂移失败；`governance-fixtures.mjs` 覆盖 allowlist、Leader
self/exempt、非 Leader Core 双审、社区一审、Dependabot current-head Leader 审批和 scope
不合规回退。远端 Rulesets 只在管理员显式 apply 后迁移，并须通过 API readback 与
`gh ruleset check`；管理员 apply 后必须再次 readback，确认 reviewer 参数和 Actions
integration `15368` 均无漂移。

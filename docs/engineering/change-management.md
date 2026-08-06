# 文档、RFC 与变更管理

规范文档采用中文优先、保留英文技术术语。新增工程文档应包含 `owner`、`status`、`last_reviewed` 和 `review_cycle_days` 元数据；内部链接、过期元数据和索引漂移由 `make governance-check` 阻断。

架构和高风险行为改变必须先有 ADR/RFC，至少记录背景、决策、替代方案、风险、迁移、回滚和验证方式。紧急修复也要在事后两个工作日内补齐复盘。

评审计数遵循 [ADR-0003](../adr/ADR-0003-leader-self-approval-policy.md) 与 [ADR-0005](../adr/ADR-0005-governance-review-native-ruleset.md)：`@Misakago` 作为 PR 作者时采用 `self-or-exempt`，额外治理审批要求为 0；Leader 对其他所有 PR（包括 Dependabot 等自动化作者）的当前 head 有效审批可计一票且只计一次，但不能为自己实际 push 的非 Leader head 计票。非 Leader Core 作者需要两名不同、非作者且在 `coreReviewerLogins` allowlist 中的当前 head 审批，社区作者需要一名 allowlist 审批；高风险 PR 仍必须有 Leader 参与，且 Leader 不能以实际最后 push 者身份满足该参与。实际最后 push 者优先从绑定当前 `repository + PR number + headRef` 的 trusted `governance-review-pusher` commit status 恢复；没有可复用的绑定记录时才由匹配当前 head/分支的 head 仓库 `PushEvent` 证明，旧格式、跨 PR/分支记录和 PR `opened` opener 不被接受；证据缺失时 fail-closed。trusted workflow 写入前必须验证仓库 Actions 默认权限为 read-only 且禁止批准 PR。初始 allowlist 只有 Leader 时，非 Leader Core 双审会明确 fail-closed，不猜测组织成员身份；由 Leader 登记至少两名 Core 身份后才开放该路径。`pull_request_target` 只读取 trusted base 上的治理脚本与 PR 元数据，未知 reviewer 身份 fail-closed；CODEOWNERS 仅作 ownership metadata，`governance-review` 是 required status 与审批计数权威，且 required status 绑定 GitHub Actions integration `15368`，不创建 Misaka 专用 bypass actor。

Dependabot 低风险依赖升级遵循 [ADR-0004](../adr/ADR-0004-dependabot-leader-review.md)：仅在机器分类确认变更范围时由 Leader 单独审批；任何产品、服务器、治理、安全或发布路径都不能借此降级。native last-push approval 为 false 以支持 Leader self/exempt，`governance-review` 对需审批作者执行 current-head 与实际最后 push 者约束；签名、CODEOWNERS metadata、线程和 required-check 约束仍保留。

## 单人 Leader-only Bootstrap

当前显式 Core allowlist 只有 `@Misakago`，因此 `.governance/github-policy.json` 的
`bootstrap` 仅作用于非 Leader Core 作者路径：该路径在 allowlist 少于 3 人时继续
fail-closed；Leader 作者、社区作者和低风险 Dependabot 的既有规则不被 Bootstrap 改写。
`governance-bootstrap-audit` 从 trusted `main` 只读检查 allowlist、起始日、90 天期限、
Ruleset/旧 Branch Protection readback 与 Actions 只读权限，并为 docs-only PR 输出确定的
no-op 状态。达到 3 个显式 Core 身份或超过期限时，审计报告需要切换，直接失败；机器人
不会写 policy、Team、Ruleset、Issue 或 PR。切换只能通过本机 Good signature 的策略 PR，
将 `state` 明确迁移为 `full-core` 并同时更新显式 allowlist；不得读取组织成员清单或猜测身份。

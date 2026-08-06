# 项目治理

## 角色

- `@Misakago`：项目 Leader/Owner，负责产品方向、发布、安全升级、最终争议裁决和 Core Team 任命。
- `@agentbridges-ai/piwork-core`：约五名具有 Write 权限的核心开发者，负责日常维护、代码评审、事故响应和社区协作。
- 社区贡献者：通过 Fork/PR 提交改动，不默认拥有仓库写权限。
- `@agentbridges-ai/piwork-leads`：Leader 与后续指定的 Leads，用于发布、规则维护和审计式 PR-only bypass。

## 决策流程

普通实现采用 PR 共识；影响公共协议、权限/隔离、数据迁移、Pi 运行时、供应链或发布的改动必须在 PR 中链接 RFC，并遵循高风险评审规则。出现无法解决的产品或安全分歧时由 Owner 作最终裁决。

评审计数由 trusted-base 的 `pull_request_target` 工作流 `governance-review` fail-closed 执行：`@Misakago` 作为作者时使用 `self-or-exempt`，额外治理审批为 0；Leader 对所有其他 PR（包括 Dependabot 等非人类作者）的当前 head 有效 `APPROVED` 可计为一票且每个 PR 只计一次。非 Leader Core 作者需要 2 个当前 head、不同且在 `.governance/github-policy.json` `coreReviewerLogins` allowlist 中的非作者审批；社区作者需要 1 个 allowlist 审批。高风险路径在此基础上仍要求 Leader 参与。未知 reviewer login 不计票，allowlist 未登记的 Core 成员会阻断而不是被猜测为 Core；初始只有 Leader 时，非 Leader Core 的双审配置明确 fail-closed，待 Leader 登记至少两名 Core 身份后才可通过。CODEOWNERS 保留为 ownership metadata；主/高风险 Ruleset 不再要求 Team/CODEOWNER 审批，必须要求 `governance-review` 状态。

Dependabot 的自动化依赖升级是一个窄化的低风险例外：当作者为 `dependabot[bot]` 或 `app/dependabot`，且变更仅限依赖清单、锁文件、SHA 固定的 Actions，及配套的精确 SHA fixture 时，只要求 `@Misakago` 对当前 head 有 1 个有效 `APPROVED`。`scripts/governance/review-policy.mjs` 会按 REST 文件 patch 做范围分类；`web/server`、`web/shared`、产品代码、`.governance`、发布、安全或其他高风险路径一律退出该分类并回退普通/高风险规则。Leader 不能作为该低风险 PR 的实际最后 push 者来满足治理的 current-head 约束；实际 push 身份优先从绑定当前 `repository + PR number + headRef` 的 trusted `governance-review-pusher` commit status 恢复，没有可复用的绑定 status 时才从匹配当前 head 与分支的 head 仓库 `PushEvent` actor 读取并持久化；绝不接受 PR `opened` 事件的 opener，缺失或跨 PR/分支证据时 fail-closed。手工重放必须由 Dependabot/其他非 Leader 提交者重新生成 head 并重新获取 Leader 审批。native last-push approval 为 false 以允许 Leader self/exempt，`governance-review` 对需要审批的作者执行 current-head 约束；Verified 签名、线程解决、所有 required checks、Dependency Review、安全扫描与发布门禁仍由平台/工作流强制。

`governance-review` 是 required status，也是唯一的 author-aware approval authority；它只读取 trusted base 上的治理脚本、PR 文件、current-head reviews 和显式 reviewer allowlist，不读取组织成员清单。Ruleset 的每个 required status 都绑定 GitHub Actions integration `15368`，并且 trusted workflow 在写入前验证仓库 Actions 默认权限为 read-only、禁止批准 PR，防止同一 Actions app 的不受信任 workflow 伪造状态。工作流并发组按事件类型隔离，同一 PR 的 `pull_request_target` 与 `pull_request_review` 不会互相取消而留下 required failure；同类事件仍按 PR 去重。原生 Ruleset 的 required approving review count 为 0、`required_reviewers=[]`、`require_code_owner_review=false`、`require_last_push_approval=false`，以避免 Team/CODEOWNER/last-push reviewer 阻断 Leader 自审；治理状态对所有非 Leader 作者执行 current-head 审批和实际最后 push 者排除，对低风险 Dependabot 还要求 Leader 不是实际最后 push 者。实际 push 身份优先从绑定当前 `repository + PR number + headRef` 的 trusted `governance-review-pusher` commit status 恢复，否则来自匹配当前 head/branch 的 head 仓库 `PushEvent` actor；无法证明或证据绑定到其他 PR/分支时直接失败。PR opened opener 不作为 push 证据。签名、线性历史、线程解决和 required status 仍由 Ruleset 强制。不得创建或配置 Misaka 专用 bypass actor。只有确实无法满足非 Leader/社区作者的独立成员审批时，才可使用已登记的 `piwork-leads` PR-only bypass，并记录原因、范围、跟踪 Issue 和复盘期限。

单人阶段使用显式 `.governance/github-policy.json` `bootstrap`：只有非 Leader Core 作者路径受 `leader-only` Bootstrap 约束；Leader 作者、社区作者和低风险 Dependabot 规则不变。`governance-bootstrap-audit` 从 trusted `main` 只读审计起始日、90 天期限、三名显式 Core 身份阈值、Ruleset/旧保护 readback 和工作流权限声明。PR token 不查询仅管理员可读的 Actions 权限端点；仓库级 `default_workflow_permissions` 与 `can_approve_pull_request_reviews` 仍由显式管理员 `github-governance-check/apply` 做 readback/apply。超过期限、达到阈值或发生范围/配置漂移时 fail-closed；切换只能由 Leader 以 Good signature 提交策略 PR，机器人不修改 policy、Team、Ruleset、Issue 或 PR。

紧急修复仍必须通过 PR。只有 `piwork-leads` 可以使用 Ruleset 的 PR-only bypass；PR 必须写明原因、影响、回滚方式和跟踪 Issue，并在两个工作日内完成复盘。

## 变更与成员

Core Team 成员通过 GitHub Team 管理，不通过 CODEOWNERS 文件逐人维护。新增成员需要能独立处理测试、权限和安全边界，并得到 Owner 的任命；移除成员应立即撤销 Team 权限并复查其未合并分支。

所有规范控制项、例外和延期事项以 `.governance/` 为机器权威，以 `docs/engineering/` 为人类入口。新增缓存、队列、托管服务、对象存储、IaC 或 hosted SLO 前必须先提交 RFC。

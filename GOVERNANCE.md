# 项目治理

## 角色

- `@Misakago`：项目 Leader/Owner，负责产品方向、发布、安全升级、最终争议裁决和 Core Team 任命。
- `@agentbridges-ai/piwork-core`：约五名具有 Write 权限的核心开发者，负责日常维护、代码评审、事故响应和社区协作。
- 社区贡献者：通过 Fork/PR 提交改动，不默认拥有仓库写权限。
- `@agentbridges-ai/piwork-leads`：Leader 与后续指定的 Leads，用于发布、规则维护和必要时的 PR-only 紧急审计操作。

## 决策流程

普通实现采用 PR 共识；影响公共协议、权限/隔离、数据迁移、Pi 运行时、供应链或发布的改动必须在 PR 中链接 RFC，并遵循高风险评审规则。出现无法解决的产品或安全分歧时由 Owner 作最终裁决。

评审计数按 PR 作者动态执行：普通作者（含社区贡献者）需要至少 1 个当前 head 的非作者 Core 审批；`@Misakago` 作为作者同样需要 1 个独立审批；非 Leader Core 作者需要至少 2 个当前 head 的非作者 Core 审批。不存在按作者提供免审、self-review 计数或专用豁免的规则。高风险路径在此基础上仍要求 Leader 作为作者或最新提交批准者参与。`governance-review` 只读取 PR 元数据与评审，不读取组织成员清单，并使用 GitHub 的作者关联类型识别 Core 作者。

该条件策略只影响 `governance-review` 的机器计数，不改变 GitHub CODEOWNERS、Ruleset、required approving review、last-push approval 或平台禁止作者自审的限制。所有作者都必须满足对应的独立审批数；不得创建或配置 Misaka 专用 bypass actor。历史上登记的 `piwork-leads` PR-only bootstrap 记录仅用于审计；未来紧急操作仍必须是有原因、有范围、有跟踪 Issue 和复盘期限的 PR-only 例外，不构成任何作者免审规则。

紧急修复仍必须通过 PR。只有 `piwork-leads` 可以使用 Ruleset 的 PR-only bypass；PR 必须写明原因、影响、回滚方式和跟踪 Issue，并在两个工作日内完成复盘。

## 变更与成员

Core Team 成员通过 GitHub Team 管理，不通过 CODEOWNERS 文件逐人维护。新增成员需要能独立处理测试、权限和安全边界，并得到 Owner 的任命；移除成员应立即撤销 Team 权限并复查其未合并分支。

所有规范控制项、例外和延期事项以 `.governance/` 为机器权威，以 `docs/engineering/` 为人类入口。新增缓存、队列、托管服务、对象存储、IaC 或 hosted SLO 前必须先提交 RFC。

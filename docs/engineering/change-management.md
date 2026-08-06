# 文档、RFC 与变更管理

规范文档采用中文优先、保留英文技术术语。新增工程文档应包含 `owner`、`status`、`last_reviewed` 和 `review_cycle_days` 元数据；内部链接、过期元数据和索引漂移由 `make governance-check` 阻断。

架构和高风险行为改变必须先有 ADR/RFC，至少记录背景、决策、替代方案、风险、迁移、回滚和验证方式。紧急修复也要在事后两个工作日内补齐复盘。

评审计数遵循 [ADR-0003](../adr/ADR-0003-leader-review-requirement.md)：普通作者（含社区贡献者）和 `@Misakago` 作者都需要 1 个当前 head 的独立审批，非 Leader Core 作者需要 2 个当前 head 的非作者 Core 审批。作者自己的 Review 永远不计入，不存在按作者提供免审或专用豁免。高风险 PR 仍必须有 Leader 参与。`pull_request_target` 只读取 trusted base 上的治理脚本与 PR 元数据；GitHub 原生 required review 无法表达作者类别的不同数量时，以 `governance-review` 策略状态确认独立审批数，不创建 Misaka 专用 bypass actor。

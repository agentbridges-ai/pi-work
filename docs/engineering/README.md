# 工程治理入口

Piwork 的工程治理采用“基线 + ratchet”。`.governance/controls.json` 是控制项的机器权威；本目录解释适用范围、证据和延期事项。每个新增控制必须同时更新机器清单、文档入口和对应 CI/运行证据。

## 状态定义

- **Enforced**：有自动化门禁或运行时硬约束，违规阻断合并/发布。
- **Documented**：有规范、模板或 Runbook，尚未适合放入每次 PR 的硬门禁。
- **Deferred**：明确不在当前架构范围，必须登记 RFC 和 Owner。
- **N/A**：当前 local-first 产品没有该资源或运行面；未来引入时必须重新评估。

附件中的 30 类标准已经登记在 `controls.json`。本仓库保留 Pi 原生 Agent 能力、Better Auth + Postgres、按用户/Session 的文件隔离、原生 Pi RPC、User Space 和 OnlyOffice 外部仓边界；这些产品不变量优先级高于通用模板。

## 标准分组

- [架构、代码与边界](architecture.md)
- [合约、数据与兼容性](contracts.md)
- [安全、依赖与供应链](security.md)
- [Dependabot 低风险审批](dependencies.md#dependabot-低风险审批)
- [测试、CI 与发布](delivery.md)
- [运行、日志、指标与恢复](operations.md)
- [文档、RFC 与变更管理](change-management.md)
- [Worktree Harness 并行开发与里程碑收口](worktree-harness.md)
- [Leader-only Bootstrap 审计](change-management.md#单人-leader-only-bootstrap)

## 例外与债务

例外必须写入 `.governance/exceptions.json`，并有可访问的 GitHub Issue、批准人和到期时间。技术债不得通过关闭 lint 或删除测试隐藏；新增债务要在 PR 中链接债务条目。

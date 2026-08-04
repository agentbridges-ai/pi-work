# 测试、CI 与发布

PR 必须通过治理、质量、认证 E2E、SRT、完整验证、Landing、依赖和治理评审状态。路径无关的作业也必须报告确定的成功 no-op 状态。

主分支保持可发布。Release Please 使用 SemVer 标签和根 CHANGELOG；Landing 构建一次并部署同一 artifact。OnlyOffice 的候选、生产身份和 Promotion 规则继续由现有 manifest 和独立仓治理。

生产 Environment 由 `make github-governance-apply -- --apply` 幂等配置为仅接受 `main`，不设置人工审批；仓库 Actions 默认只读且不得批准 PR。`v*` 标签 Ruleset 只允许 GitHub Actions Release automation 或 `piwork-leads` 创建，更新和删除均被禁止。新 Ruleset 完成 API readback 与 `gh ruleset check` 后，才可使用 `--retire-legacy` 移除旧保护。

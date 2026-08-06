# 测试、CI 与发布

PR 必须通过治理、质量、认证 E2E、SRT、完整验证、Landing、依赖和治理评审状态。路径无关的作业也必须报告确定的成功 no-op 状态。

`governance-review` 是 trusted `pull_request_target` 产生的必需状态，负责按作者和显式
reviewer allowlist 计算 0/2/1 审批；Leader 对所有其他 PR（包括自动化作者）的一次当前-head
有效审批计一票，Leader 作者为 self-or-exempt；CODEOWNERS 只记录 ownership，不再由 Ruleset
强制 Team/CODEOWNER 审批。native last-push approval 为 false 以支持 Leader self/exempt，
`governance-review` 对需审批作者执行 current-head 与实际最后 push 者约束（身份优先来自 trusted
`governance-review-pusher` commit status，否则来自 `synchronize` sender 或匹配当前 head/分支的 head 仓库 `PushEvent` actor；PR `opened` opener 不被接受，缺失时 fail-closed；trusted workflow 写入前验证仓库 Actions 默认权限为 read-only 且禁止批准 PR；同一 PR 的 `pull_request_target` 与 `pull_request_review` 并发组隔离，避免跨事件取消 required status）；Ruleset 仍强制签名、线性历史、
线程解决与全部 required checks，且状态只接受 GitHub Actions integration `15368`，因此状态缺失、
allowlist 漂移或未知 reviewer 都 fail-closed。

主分支保持可发布。Release Please 使用 SemVer 标签和根 CHANGELOG；Landing 构建一次并部署同一 artifact。OnlyOffice 的候选、生产身份和 Promotion 规则继续由现有 manifest 和独立仓治理。

生产 Environment 由 `make github-governance-apply -- --apply` 幂等配置为仅接受 `main`，不设置人工审批；仓库 Actions 默认只读且不得批准 PR。`v*` 标签 Ruleset 只允许 GitHub Actions Release automation 或 `piwork-leads` 创建，更新和删除均被禁止。新 Ruleset 完成 API readback 与 `gh ruleset check` 后，才可使用 `--retire-legacy` 移除旧保护。

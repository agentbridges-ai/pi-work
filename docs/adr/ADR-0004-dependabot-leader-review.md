---
owner: Misakago
status: accepted
last_reviewed: 2026-08-06
review_cycle_days: 90
---

# ADR-0004：Dependabot 低风险依赖升级由 Leader 单独审批

## Context

Dependabot 的常规依赖、锁文件和 SHA 固定 Actions 更新是可重复的自动化变更，
但 GitHub 的原生 Ruleset 不按 PR 作者区分审批数量。依赖 PR 也可能错误地混入
产品、认证、安全、治理或发布文件，因此不能按 bot 身份全局放宽审查。

## Decision

当 PR 作者精确为 `dependabot[bot]` 或 `app/dependabot`，且文件 patch 仅包含
依赖清单/锁文件、SHA 固定的 workflow action，以及可选的精确 SHA fixture 时，
`governance-review` 要求 Leader `@Misakago` 对当前 head 有一个真实的
`APPROVED` Review。路径分类在 trusted-base 脚本中完成，产品、服务器、共享协议、
`.governance`、安全、发布和其他高风险路径一律退出该低风险分类。

Leader 不能同时作为该 head 的实际最后 push 者来满足治理的
current-head 约束；`governance-review` 从 trusted `pull_request_target` workflow run 的
`opened/synchronize` actor 读取该身份，在这种手工重放场景失败并提示重新生成 head，
绝不伪造 Review、修改 Ruleset 或使用 bypass。native `require_last_push_approval` 关闭
以支持 Leader self-or-exempt；Verified 签名、CODEOWNERS ownership metadata、全部
required checks、Dependency Review、安全扫描与发布门禁继续由平台强制。

## Alternatives rejected

- 按 `dependabot[bot]` 身份对所有文件免审：会把产品和安全变更误降级。
- 用 Leader/Dependabot 专用 Ruleset bypass：绕过平台审计且无法表达最后推送约束。
- 接受过期 head 或 Leader 自己重放的提交审批：会失效 latest-head 与签名证据。

## Verification

`governance-fixtures.mjs` 覆盖合法依赖/Action pin、服务器和 release 清单拒绝、
workflow 非 pin 拒绝、非 Leader reviewer、旧 head 审批以及实际最后 push 者证据缺失/Leader 自推
的 governance current-head 约束；机器策略位于 `.governance/github-policy.json`。

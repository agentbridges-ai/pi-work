# 依赖与许可证

依赖清单由 `web/bun.lock` 和 `landing-page/bun.lock` 固定；Dependabot 每周检查两个应用和 GitHub Actions。PR 上的 Dependency Review 与两个应用的 `bun audit --audit-level=high` 共同阻断新的 High/Critical 漏洞。

许可证采用 ratchet：常见宽松许可证默认允许；强 Copyleft 或 Unknown 必须由 `@Misakago` 批准并登记 `.governance/exceptions.json`。`scripts/governance/license-report.mjs` 检查直接依赖清单和许可证字段，后续可扩展到完整 SPDX 依赖图。

## Runtime pins 与 Dependabot

`web/package.json` 中的 `@anthropic-ai/sandbox-runtime`、`@earendil-works/pi-ai`、
`@earendil-works/pi-coding-agent` 和 `@modelcontextprotocol/sdk` 是 Native Pi/SRT
运行时的协同 exact pin。`.github/dependabot.yml` 不为这四项生成独立更新；升级必须
在 RFC 中说明兼容性、运行时安全边界和回滚，并通过 SRT/native Pi canary。

普通依赖 PR 可以更新 `web/bun.lock`，但不应被已发布 OnlyOffice descriptor 的
lockfile digest 阻断。`verify-onlyoffice-release.mjs --allow-dependency-lockfile-drift`
只在 `pull_request`、`merge_group` 或 `main` push 的开发验证中传入，并且先比较
descriptor 是否改变；descriptor 发生变化时仍严格校验 digest。tag、release、
production 和显式 candidate integration 永远不传该 flag。

CodeQL Action 的 Dependabot 更新必须把 `init`、`autobuild`、`analyze` 作为一个
原子变更，并统一到同一完整 SHA。当前 v4 迁移使用 `build-mode: none` 的
JavaScript/TypeScript 分支并移除 `autobuild`；GitHub Actions 分支保留独立的合法
`init`。后续 major 升级需要单独 RFC/审查，不能只升级矩阵中的一个 action。

## Dependabot 低风险审批

Dependabot 作者（`dependabot[bot]` 或 `app/dependabot`）的依赖升级 PR 可以由
Leader `@Misakago` 对当前 head 单独投一票审批，但只适用于 `.governance/github-policy.json` 中列明的
依赖清单、锁文件、SHA 固定 Actions，以及随 Actions 一起变化的精确 SHA fixture。
`web/server`、`web/shared`、前端产品代码、认证/安全、发布清单、治理配置和其他
高风险路径不会因为作者是 Dependabot 而降级；混入这些路径会回到普通/高风险评审。

`governance-review` 要求 Leader 对低风险当前 head 有一个真实的 `APPROVED` Review，
并拒绝 Leader 同时作为实际最后 push 者的手工重放；该身份优先从绑定当前
`repository + PR number + headRef` 的 trusted `governance-review-pusher` commit status 恢复，没有可复用的绑定记录时才由匹配当前 head/分支的 head 仓库 `PushEvent` actor 证明；旧格式、跨 PR/分支记录和 PR `opened` opener 不被接受，缺失时 fail-closed；trusted workflow 写入前验证仓库 Actions 默认权限为 read-only 且禁止批准 PR；scope 不合规时回退
普通/高风险规则。CODEOWNERS 只保留 ownership metadata，主/高风险 Ruleset 将 native reviewer
count 设为 0 且关闭 native last-push approval 以避免阻断 Leader 自审；对需审批作者由
`governance-review` 执行 current-head 约束。签名提交、线程解决、必需 CI 状态、Dependency
Review 和安全扫描仍由 GitHub 原生 Ruleset/工作流强制。该分类
不是 bypass，也不会创建 Dependabot 或 Leader 专用绕过人。

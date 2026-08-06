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

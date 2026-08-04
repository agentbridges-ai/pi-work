# 依赖与许可证

依赖清单由 `web/bun.lock` 和 `landing-page/bun.lock` 固定；Dependabot 每周检查两个应用和 GitHub Actions。PR 上的 Dependency Review 与两个应用的 `bun audit --audit-level=high` 共同阻断新的 High/Critical 漏洞。

许可证采用 ratchet：常见宽松许可证默认允许；强 Copyleft 或 Unknown 必须由 `@Misakago` 批准并登记 `.governance/exceptions.json`。`scripts/governance/license-report.mjs` 检查直接依赖清单和许可证字段，后续可扩展到完整 SPDX 依赖图。

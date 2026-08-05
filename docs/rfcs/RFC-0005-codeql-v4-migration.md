---
owner: Misakago
status: accepted
last_reviewed: 2026-08-05
review_cycle_days: 90
---

# RFC-0005：CodeQL Action v4 成组迁移

## 问题

Dependabot 只升级 `github/codeql-action/init` 会让 `init`、`autobuild` 和
`analyze` 运行在不同主版本。CodeQL Action v4 读取由 v4 产生的配置时，旧版
步骤可能报告配置缺少预期 `version` 字段，导致依赖 PR 在真正的代码检查前失败。

## 决策

- 三个 CodeQL 步骤必须使用同一个完整 commit SHA 和同一 v4 版本注释。
- JavaScript/TypeScript 是解释型分析，使用 `build-mode: none`，不再运行
  `autobuild`。
- GitHub Actions 使用独立的 v4 `init` 分支；`analyze` 仍统一使用同一 SHA。
- `.github/workflows/codeql.yml` 由 `make governance-check` 的 fixture 检查成组、
  SHA 固定和 build-mode 边界。

## 非目标与回滚

本 RFC 不降低 CodeQL 查询集、Required 状态或 High/Critical 阻断。如果 v4 在
GitHub runner 上仍失败，回滚必须恢复三步同一 v3 SHA，并另开迁移 Issue；不得
通过关闭 CodeQL 或放宽 Ruleset 掩盖错误。

## 验收

本地 Action pinning、治理 fixture、YAML 结构和 CodeQL workflow 运行均通过；
至少验证一次 `javascript-typescript` 与 `actions` 两个矩阵分支的成功状态。

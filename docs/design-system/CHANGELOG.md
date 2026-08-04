# Changelog

## 0.1.0 — 2026-08-04

- 建立 Primitive、Semantic、Component 三层 token API 与共享 light/dark theme CSS。
- 将 Web 组件实现迁移到 `@piwork/ui`，保留原导入路径兼容层。
- 增加 `ButtonLink`，统一动作与导航的语义样式。
- 建立 `PageLayout`、`PageHeader`、`FilterBar`、`FormSection` Pattern。
- 让 Web 与 Landing Page 共用主题，并让 Landing 消费公共组件与 Pattern。
- 增加 workspace、主题边界、魔法值与可访问性治理测试。

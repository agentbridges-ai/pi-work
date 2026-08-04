# Governance

## 组件准入

新增公共组件或 Pattern 前先回答：

1. 是否至少覆盖两个真实产品场景？
2. 现有组件能否通过稳定的语义变体覆盖？
3. 这是通用交互还是单一业务模块？
4. API 是否隐藏视觉魔法值并保持可访问性？
5. Light、Dark、键盘、触控、loading、disabled、error 是否有明确行为？

单一业务组件先留在应用中。重复场景稳定后再提取，避免把偶然需求固化成公共 API。

## 变更流程

1. 在 issue 或 PR 描述中写明使用场景、非目标和 API 草案。
2. 设计评审关注语义、状态、内容与 Pattern；工程评审关注 API、可访问性、bundle 与迁移成本。
3. 同一变更中更新 token / component / pattern、文档和测试。
4. 运行 `bun run design-system:check`、`make typecheck` 与相关 build。
5. 记录版本与迁移说明。

## 静态约束

当前自动策略包括：

- Web 与 Landing 必须导入共享 theme CSS。
- HeroUI 只能在 `packages/ui` 内作为实现引擎使用。
- Web 业务 UI 禁止硬编码色值、非语义色彩 utility、任意圆角、数字 z-index、阴影和玻璃效果。
- Landing 业务 UI 禁止 raw hex、阴影、玻璃效果和原生 `<button>`。
- CSS custom property 引用必须有定义。
- 公共组件与 Pattern 必须通过键盘与 axe 回归测试。

新增约束应先修复现有违规，再作为 fail-closed 测试合入；禁止用不断增长的全局 allowlist 掩盖债务。

## 版本与废弃

- Patch：不改变 API 的视觉修复、可访问性修复和文档修复。
- Minor：向后兼容的新组件、新 Pattern、新 optional prop。
- Major：删除或改变既有行为、token、variant 或结构。

废弃流程：先标记 `@deprecated` 并提供替代方式；至少保留一个迁移周期；记录调用方；完成迁移后再删除。不得静默改变语义或复用旧 variant 名称表达新用途。

## Ownership

设计系统改动至少需要一名产品设计/UX 评审者和一名前端评审者。涉及认证、跨用户数据、OnlyOffice、User Space 或 Agent runtime 的改动还必须由对应领域 owner 评审，Design System 不覆盖这些产品安全边界。

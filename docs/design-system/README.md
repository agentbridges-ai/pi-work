# Piwork Design System

Piwork Design System 是 Web 工作台与 Landing Page 共用的设计语言、组件 API、页面模式和治理规则。它不是一份静态 Style Guide；代码包负责落地，测试负责约束，本文档负责解释决策。

## 架构

```text
packages/design-tokens     Primitive、Semantic、Component token 与主题 CSS
          ↓
packages/ui                可访问性组件与受限语义 API
          ↓
packages/ui-patterns       页面布局、筛选区、表单区等组合模式
          ↓
web / landing-page         产品应用，只消费公共契约
```

HeroUI v3 是底层可访问性引擎，但不是业务代码的公共 API。除 `packages/ui` 外，产品代码不得直接导入 `@heroui/react`。

## 快速使用

应用入口只需加载一次主题：

```css
@import "tailwindcss";
@import "@piwork/design-tokens/theme.css";
```

业务组件使用语义 API：

```tsx
import { Button, TextField } from "@piwork/ui";
import { FormSection, PageHeader, PageLayout } from "@piwork/ui-patterns";

<PageLayout>
  <PageHeader title="成员" actions={<Button>新建成员</Button>} />
  <FormSection title="基本信息">
    <TextField label="姓名" />
  </FormSection>
</PageLayout>;
```

## 文档导航

- [Foundations](./foundations.md)：Token 分层、主题、排版、间距、动效、层级与 evidence-first 页面原则。
- [Components](./components.md)：组件 API、适用场景、Accessibility 与 Do / Don't。
- [Patterns](./patterns.md)：页面和交互组合规范。
- [Governance](./governance.md)：贡献、评审、版本、废弃与静态约束。
- [Changelog](./CHANGELOG.md)：设计系统版本记录。

## 验证

```bash
bun run design-system:check
make typecheck
make build
```

`design-system:check` 会验证两端应用都加载统一主题、HeroUI 不越过公共组件边界、Landing Page 不重新引入魔法颜色、阴影、玻璃效果或原生按钮，并运行组件与 Pattern 的可访问性回归测试。

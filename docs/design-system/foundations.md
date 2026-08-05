# Foundations

## Token 分层

### Primitive Tokens

Primitive 是颜色、间距、圆角和时间等原始值，只供主题作者维护。TypeScript 入口是 `primitiveTokens`，CSS 中的具体 OKLCH 和尺寸值只允许存在于 `packages/design-tokens/src/theme.css`。

业务代码不得依赖 Primitive。否则品牌色、暗色主题或密度调整会变成全仓替换。

### Semantic Tokens

Semantic Token 描述用途，不描述具体外观：

| 用途     | CSS Token            | Tailwind role               |
| -------- | -------------------- | --------------------------- |
| 页面背景 | `--background`       | `bg-background`             |
| 容器背景 | `--card`             | `bg-card`                   |
| 主要文字 | `--foreground`       | `text-foreground`           |
| 次要文字 | `--muted-foreground` | `text-muted-foreground`     |
| 分隔线   | `--border`           | `border-border`             |
| 主要操作 | `--primary`          | `bg-primary`                |
| 危险状态 | `--danger`           | `text-danger` / `bg-danger` |

业务页面优先使用这一层。

### Component Tokens

Component Token 固定组件内部几何与状态，例如：

- `--piwork-control-radius`
- `--piwork-control-height-md`
- `--piwork-panel-radius`
- `--piwork-composer-background`
- `--piwork-duration-feedback`

它们可由组件和 Pattern 使用，业务页面不应重新声明。

## 主题

Light 与 Dark 使用相同的语义角色。主题切换只改变角色映射，不改变组件 API：

```html
<html class="dark" data-theme="dark"></html>
```

颜色使用 OKLCH。文本、占位符、控件边界和主要操作的对比度由 `color-contrast.test.ts` 持续验证。

## 视觉原则

- 层级来自背景、边界和排版，不使用阴影或玻璃模糊。
- 颜色表达语义意图，不把某个固定色号当作组件 API。
- 圆角只使用 control、panel、composer 三种公开层级。
- 反馈、浮层、布局动效分别使用统一 duration token，并尊重 reduced motion。
- z-index 使用命名 token，不使用 `9999` 一类魔法值。

## Evidence-first 页面原则

Piwork 吸收成熟报告型页面的判断标准，但不复制任何外部品牌资源、字体、CSS 类名或组件 API。它们适用于 Landing、公开文档和需要解释复杂工作的产品页面：

- 页面先回答读者的任务、结论或下一步，再补充背景；首屏不能只是标题、装饰或模板占位语句。
- 每个主要区块只承载一个焦点关系。用标题、正文、对齐和留白建立层级，再决定是否需要边界或容器。
- 标题使用句式大小写和具体动词；不使用全大写 eyebrow、装饰性编号或无意义的过程文案。
- 数据与事实必须保留单位、时间范围、比较基准和限制。表格使用语义 HTML，数值列在表头和单元格中保持同向对齐。
- 可交互控件必须有真实行为；没有实现搜索、快捷键或动作时，不展示对应的输入框、提示或装饰图标。
- 默认保持静止，不使用装饰性渐变、发光、阴影、毛玻璃、自动滚动或必须依赖动画才能理解的内容。
- 响应式不是缩小桌面布局：内容要按阅读顺序重排，保持可读字号、可操作控件和明确的焦点。
- 不确定的商业信息、价格、时间或承诺要明确标记为未发布或未知，不用空卡片填充版面。

这些原则由 `web/src/design-system-contract.test.ts` 中的 Landing 与共享 Pattern 契约持续验证；视觉判断仍需结合真实渲染和人工审查。

## Do / Don't

```tsx
// Do
<div className="rounded-[var(--piwork-panel-radius)] border border-border bg-card" />

// Don't
<div className="rounded-[7px] border-[#d0d3d8] bg-[#fff] shadow-lg" />
```

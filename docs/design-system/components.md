# Components

公共组件由 `@piwork/ui` 导出。组件 API 使用 `variant`、`size`、`status` 等语义参数，避免把颜色、高度、padding 或圆角重新暴露给业务层。

## 组件目录

| 类别      | 组件                                                    |
| --------- | ------------------------------------------------------- |
| Actions   | `Button`, `ButtonLink`, `IconButton`                    |
| Fields    | `TextField`, `TextArea`, `Switch`                       |
| Selection | `SegmentedControl`, `Tabs`                              |
| Feedback  | `Alert`, `StatusBadge`, `EmptyState`, `Skeleton`        |
| Overlay   | `Dialog`, `Sheet`                                       |
| Layout    | `AppShell`, `Panel`, `Surface`, `Toolbar`, `ScrollArea` |

`engine` 与 `heroui` 子入口是迁移期的低层边界，不应成为新业务代码的默认选择。

## Button

用途：触发当前上下文中的操作。导航到另一个 URL 使用 `ButtonLink`。

```tsx
<Button variant="primary">保存</Button>
<Button variant="secondary">取消</Button>
<Button variant="danger">删除</Button>
<IconButton label="更多操作" variant="ghost">
  <MoreHorizontal aria-hidden="true" />
</IconButton>
```

Do：

- 一个页面或独立操作区通常只保留一个 Primary Button。
- 使用“保存”“提交”“删除”等明确动词。
- Icon-only 操作必须传入可读的 `label`。
- 异步提交使用 `loading`，组件会同步 disabled 与 pending 语义。

Don't：

- 不在业务侧传入颜色、任意高度或任意圆角重画按钮。
- 不用 Button 假装链接，也不用 `<a>` 假装提交操作。
- 不在同一操作区放置多个同权重 Primary Button。

## Fields

`TextField` 与 `TextArea` 把 label、description、error 与输入控件关联。即使视觉上隐藏 label，也必须通过 `labelClassName="sr-only"` 保留可访问名称。

```tsx
<TextField
  description="用于账户恢复"
  error={emailError}
  inputProps={{ type: "email" }}
  label="邮箱"
/>
```

错误文案应说明如何修复，不能只写“无效”。

## Dialog 与 Sheet

Dialog 用于需要集中注意力的短流程；Sheet 用于保留主页面上下文的辅助编辑。两者都提供焦点约束、Escape 关闭和焦点恢复。标题、关闭按钮标签必须来自应用的 i18n catalog。

## Accessibility

- 交互使用 `onPress`，由 React Aria 统一鼠标、触控和键盘语义。
- 所有交互控件必须有可访问名称。
- 不得移除 keyboard focus indicator。
- 状态不能只靠颜色表达；同时提供文本、图标或 ARIA 状态。
- 新增或修改组件必须包含键盘行为和 `axe` 测试。

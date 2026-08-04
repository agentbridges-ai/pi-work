# UI Patterns

组件解决局部一致性，Pattern 解决页面组合一致性。公共 Pattern 由 `@piwork/ui-patterns` 导出。

## PageLayout + PageHeader

适用于设置页、管理页、内容页和 Landing 内容区。`PageLayout` 统一页面宽度与边距；`PageHeader` 统一 eyebrow、标题、说明和操作区。

```tsx
<PageLayout width="wide">
  <PageHeader
    actions={<Button>新建用户</Button>}
    description="管理成员、角色和访问范围"
    title="用户管理"
  />
  {content}
</PageLayout>
```

页面操作在窄屏自动换行。不要在页面内重新创建另一套 max-width、标题间距和 action alignment。

## FilterBar

用于搜索、筛选与批量条件。必须提供 `label`，并保持搜索条件在左、次要操作在右：

```tsx
<FilterBar actions={<Button variant="ghost">重置</Button>} label="用户筛选">
  <TextField label="关键词" />
  <SegmentedControl ariaLabel="状态" items={statuses} value={status} onChange={setStatus} />
</FilterBar>
```

无筛选条件时不要渲染空 FilterBar。筛选结果的空状态应说明当前条件，并提供清除条件的动作。

## FormSection

用于设置表单和详情编辑。标题与说明在宽屏占左列，字段在右列；操作区固定在内容底部。

```tsx
<FormSection
  actions={<Button>保存</Button>}
  description="影响新建会话的默认行为"
  title="会话默认值"
>
  <TextField label="名称" />
  <Switch label="自动归档" />
</FormSection>
```

长表单拆成多个 FormSection。跨区提交时只在页面末尾保留一个主要提交动作。

## 状态模式

- Loading：内容轮廓稳定时使用 `Skeleton`；明确等待任务使用 progress indicator。
- Empty：使用 `EmptyState`，说明为什么为空以及下一步动作。
- Error：局部错误靠近触发上下文；阻断性错误使用 `Alert status="danger"`。
- Destructive action：先说明影响范围，再通过 Dialog 明确确认；确认按钮使用 danger。
- Permission denied：说明缺少的权限与申请路径，不能伪装成空数据。

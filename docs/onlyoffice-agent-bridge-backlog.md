# OnlyOffice Agent能力 Backlog

> 目标：把当前“有限结构化编辑 Beta”扩展为可稳定完成真实 Word/Excel 办公任务的Agent能力。
>
> 基线：`toy/feat/onlyoffice-browser-plugin-bridge` 在 2026-07-22 的实现状态。
>
> 相关产品现状见：[OnlyOffice Agent浏览器桥接：逆向产品文档](./onlyoffice-agent-bridge-product.md)。

## 1. 优先级原则

能力扩展遵循以下顺序：

1. **先可证明，再扩操作**：每个写操作都要能描述修改目标、前置条件、实际变更和验证结果。
2. **先稳定寻址，再精确编辑**：Word 不能长期依赖当前光标/选区；Excel 不能只靠未校验的 A1 字符串。
3. **先原子批量，再复杂工作流**：一项用户任务中的多步修改应一次执行、一次保存、整体失败，而不是留下半完成文档。
4. **先本地闭环，再考虑回退**：继续以浏览器 User Space 和 OnlyOffice/x2t-wasm 为唯一默认路径。
5. **Skill 与底层协议分层**：底层操作保持小而可验证；复杂办公任务通过 recipe/playbook 组合，不把所有规则堆进一个静态 SKILL.md。

## 2. 总览

| 阶段   | 目标                       | 建议范围                |
| ------ | -------------------------- | ----------------------- |
| P0-A   | 把桥接变成可信的编辑事务层 | 10 项基础设施待办       |
| P0-B   | Word/Excel 精确读写        | Word 8 项、Excel 10 项  |
| P1     | 覆盖日常文档结构与报表制作 | Word 10 项、Excel 12 项 |
| P2     | 模板、审阅、分析和高级报表 | Word 8 项、Excel 9 项   |
| 持续项 | Skill、测试、发布和观测    | 10 项工程化待办         |

## 3. P0-A：扩能力前必须补的地基

### F-01 真实文档 E2E 矩阵

- [ ] Word：读取 → 精确修改 → 保存 → 关闭 → 重新打开 → 验证正文和修订记录。
- [ ] Excel：写值/公式/格式 → 重算 → 保存 → 重新打开 → 验证值、公式和样式。
- [ ] Excel 图表：插入 → 保存 → 重新打开 → 验证类型、数据源、标题和位置。
- [ ] 前台编辑器与后台 target 两条路径都覆盖。
- [ ] 覆盖只读、断线、保存失败、浏览器刷新和 Server 重启。

验收：不再仅凭 mock 返回值把某个操作标记为“已支持”。

### F-02 统一业务结果 Envelope

- [ ] 所有插件操作统一返回：

```json
{
  "ok": true,
  "changed": true,
  "target": {},
  "before": {},
  "after": {},
  "warnings": [],
  "verification": {}
}
```

- [ ] Browser Executor 检测内层 `ok:false` 并提升为真正失败。
- [ ] 区分“传输成功”“API 执行成功”“文件保存成功”“回读验证成功”。
- [ ] `changed:false` 不能伪装成完成了用户要求。

### F-03 前置条件与并发冲突检测

- [ ] target 请求携带 `baseMtime`、文件大小和可选内容 hash。
- [ ] Word 精确编辑携带 expected text/fingerprint。
- [ ] Excel 写入携带 expected values/formulas 或目标区域版本摘要。
- [ ] 保存前发现文件已被外部修改时停止，不覆盖外部更改。
- [ ] 返回结构化 conflict，由 Agent 请求用户决定重读、重做或放弃。

### F-04 原子批量操作

- [ ] 新增 `batch` 协议，一次提交多个有序子操作。
- [ ] 一个 batch 在一个 `callCommand`/history point 内执行。
- [ ] 任一子操作失败时不保存部分结果。
- [ ] 一个 batch 只导出/保存一次。
- [ ] 返回每个子操作的结果和整体验证摘要。
- [ ] 限制 batch 操作数、输入字节和预计影响范围。

### F-05 稳定 Locator 协议

- [ ] Word locator 至少包含：元素类型、文档序号、内部 ID（如可用）、文本 fingerprint 和上下文。
- [ ] Excel locator 统一规范 sheet ID/name、绝对区域和命名区域。
- [ ] locator 每次执行前重新解析并验证，不直接信任旧位置。
- [ ] 文件保存/重新打开后测试 locator 的稳定性；不稳定 ID 只能作为提示，不能作为唯一权威。
- [ ] locator 失效时返回 `stale_target`，禁止退化为全文修改。

### F-06 持久幂等

- [ ] 在 session 数据中记录 request id、target、operation digest、文件前后版本和完成状态。
- [ ] 不持久化不必要的正文内容。
- [ ] 浏览器刷新或 Server 重启后可以判断操作是“未开始、执行中、已保存、已验证”。
- [ ] 对不确定状态停止并要求回读，不自动重放写操作。

### F-07 进度、取消和超时

- [ ] 增加 operation 状态：queued/opening/reading/mutating/saving/verifying/completed/failed/cancelled。
- [ ] 用户可以从工作台看到后台 Office 操作和目标文件。
- [ ] 未进入保存阶段的操作可取消。
- [ ] 保存开始后采用“等待结果并回读”的安全取消语义。
- [ ] 长操作返回阶段性进度，避免单一 60 秒黑盒等待。

### F-08 后台 target 与人工预览行为对齐

- [ ] 零字节 Word/Excel/PPT 使用 `emptyType` 创建空白文件。
- [ ] `.doc/.xls/.ppt` 复用已有格式迁移、确认和路径更新模型。
- [ ] 明确定义 `closeAfter`，或从协议删除无效参数。
- [ ] 临时编辑器也支持文件移动、挂载切换和权限撤销的 stale guard。
- [ ] 所有成功/失败/取消路径均清理 iframe、DOM、对象 URL 和 runtime lease。

### F-09 Capability Discovery

- [ ] 增加 `onlyoffice capabilities`。
- [ ] 可按 `word/cell/slide` 返回当前 Host bundle 真正支持的操作、JSON Schema、限制和版本。
- [ ] 能力来自运行时 canary，而不是只读静态技能文案。
- [ ] Agent 遇到未知能力时先查询，不猜测操作名。
- [ ] 区分 community、付费 API 和版本受限能力。

### F-10 输入和输出预算

- [ ] 为所有文本、数组、区域和 batch 建立总量限制。
- [ ] 修正 `set_range_values` 只限制每层、没有限制总单元格数的问题。
- [ ] 大文档/大区域读取必须分页，并返回 continuation token。
- [ ] 输出携带 `truncated`、`returned`、`total` 和 continuation。
- [ ] 超大任务要求 Agent 先缩小范围，不允许一次读写整本工作簿。

## 4. P0-B：Word 精确读写

### W-01 文档结构概览

- [ ] `get_document_info`：页数、字数、段落数、表格数、图片数、评论数、修订数。
- [ ] `get_document_outline`：标题层级、文本、序号和 locator。
- [ ] `get_styles_info`：实际使用的段落/字符样式及使用次数。
- [ ] `get_sections_info`：分节、页方向、页边距、页眉页脚存在性。

价值：Agent 先建立结构地图，再决定读取范围，避免每次拉全文纯文本。

### W-02 结构化段落读取

- [ ] `get_paragraphs`：按 locator/序号范围分页读取。
- [ ] 返回文本、样式、标题级别、列表信息、对齐、缩进、间距和格式摘要。
- [ ] 返回表格内/内容控件内等父级上下文。
- [ ] 返回可用于后续精确写入的 fingerprint。

### W-03 精确搜索结果

- [ ] `find_text_ranges` 返回真正的 range locator，而不是纯文本字符下标。
- [ ] 支持大小写、整词、限定标题/段落/表格/内容控件。
- [ ] 返回 occurrence、段落上下文和预计影响范围。
- [ ] 大于默认阈值时只返回摘要，并要求用户/Agent 缩小范围。

### W-04 单处/多处受控替换

- [ ] `replace_text_ranges` 接收一组 locator + expectedText + replacement。
- [ ] 支持指定第 N 处、指定段落或指定内容控件，不再只有 replace all。
- [ ] 每一处必须精确匹配 expectedText。
- [ ] 多处替换原子执行并启用修订。
- [ ] 返回每个 locator 的 before/after 和未匹配原因。

### W-05 段落级编辑

- [ ] `set_paragraph_text`。
- [ ] `insert_paragraph_before/after`。
- [ ] `delete_paragraphs`，必须携带 expected fingerprint。
- [ ] `move_paragraphs`，必须在同一 batch 内完成。
- [ ] 默认使用修订记录，并在写后重新读取相关段落。

### W-06 段落格式

- [ ] `format_paragraphs` 支持标题样式、对齐、首行/左右缩进、段前段后、行距。
- [ ] 支持项目符号和编号列表。
- [ ] 支持 keep-with-next、分页前、孤行控制等版式属性。
- [ ] 返回实际应用后的格式，而不是仅返回请求字段。

### W-07 审阅与评论读取

- [ ] `get_comments`/`get_comments_report`：评论 ID、作者、时间、状态和定位上下文。
- [ ] `get_review_report`：修订类型、作者、时间、位置和内容摘要。
- [ ] `reply_comment`、`resolve_comment`、`delete_comment`。
- [ ] 接受/拒绝修订属于高风险动作，需要显式用户确认；先做 feasibility spike。

### W-08 Word 操作收据

- [ ] 每次写入返回受影响段落、修订数变化、评论数变化和文件版本。
- [ ] 验证“修改存在”且“目标之外未变化”。
- [ ] replace/format/delete 的回读范围应由执行器自动生成，不能只依赖 Agent 记得验证。

## 5. P0-B：Excel 精确读写

### X-01 工作簿结构和区域元数据

- [ ] 扩展 `get_workbook_info`：sheet index/id、可见性、used range、表格、图表、pivot、命名区域。
- [ ] `get_range_info`：地址、行列数、值类型、公式数量、错误数量、合并状态和格式摘要。
- [ ] 对超大 used range 返回分块建议。

### X-02 分页区域读取

- [ ] `get_range_page` 按行列窗口读取值、显示文本、公式和数据类型。
- [ ] 支持只取 values/formulas/text/styles 中的必要字段。
- [ ] 返回绝对地址和 continuation。
- [ ] 禁止一次性返回超大二维数组。

### X-03 单元格搜索

- [ ] `find_cells` 可搜索值、显示文本或公式。
- [ ] 支持精确/包含、大小写、整词和限定 sheet/range。
- [ ] 返回 cell/range locator、值、公式、显示文本和邻近上下文。

### X-04 批量值和公式写入

- [ ] `set_range_formulas`，与值写入分离，支持二维公式矩阵。
- [ ] `set_cells` 支持稀疏 cell map，避免为了改 3 个格子发送巨大矩阵。
- [ ] `clear_range` 区分 contents/formulas/formats/comments/hyperlinks。
- [ ] 写前校验目标形状与输入矩阵形状一致。
- [ ] 返回实际写入 cell 数和回读值。

### X-05 重算和公式错误

- [ ] `recalculate_workbook`/`recalculate_sheet`。
- [ ] `get_formula_errors`：`#REF!`、`#DIV/0!`、`#VALUE!` 等及其地址。
- [ ] 公式写入后默认重算，并验证结果或明确说明结果尚不可用。
- [ ] 防止“公式字符串写入成功”被误判为模型正确。

### X-06 行列与区域结构操作

- [ ] 插入/删除行列。
- [ ] 复制/移动区域。
- [ ] fill down/right 和序列填充。
- [ ] 合并/取消合并单元格。
- [ ] 所有结构操作必须携带 expected used range 和影响范围预估。

### X-07 Sheet 管理

- [ ] 新建、重命名、复制、移动、隐藏/显示工作表。
- [ ] 删除工作表要求显式用户确认，并先验证不是最后一张可见表。
- [ ] sheet 引用优先使用稳定 ID + 名称双重校验。

### X-08 排序

- [ ] `sort_range` 支持最多三个 key、升降序和 header 语义。
- [ ] 排序前返回样本和预计行数。
- [ ] 排序后验证 key 列单调性和整行数据未错位。
- [ ] 禁止只排序单列造成行关系破坏，除非用户明确要求。

### X-09 过滤

- [ ] `set_auto_filter`、`apply_filter`、`clear_filter`、`get_filters`。
- [ ] 过滤后返回可见/隐藏行数。
- [ ] 导出/保存后验证过滤状态保留。
- [ ] 当前运行时按 9.3 能力做 canary，不假设最新文档中的所有过滤 API 都存在。

### X-10 高级格式基础

- [ ] 边框、水平/垂直对齐、自动换行、文本旋转。
- [ ] 列宽、行高、自动适配。
- [ ] 保护 number format，避免写值时意外改变日期、货币和百分比语义。
- [ ] 格式写后读取实际格式摘要。

## 6. P1：Word 日常办公结构

### W-09 表格读取

- [ ] `get_tables_info`：表格 locator、行列、标题、描述、样式和文本摘要。
- [ ] `get_table_range`：按行列窗口读取单元格内容。
- [ ] 识别嵌套表格和合并单元格。

### W-10 表格编辑

- [ ] 插入/删除行列、设置单元格文本。
- [ ] 合并/拆分单元格。
- [ ] 表头、边框、底色、宽度、对齐和样式。
- [ ] 所有写入在一个 batch 内，写后重新读取表格结构。

### W-11 书签

- [ ] 列出书签和对应文本范围。
- [ ] 按书签读取/替换/插入。
- [ ] 新建、删除书签。
- [ ] 将书签作为模板和长文档的首选稳定锚点。

### W-12 内容控件与表单填充

- [ ] 列出 content control 的 tag、类型、内容和位置。
- [ ] 按 tag 精确填充文本、日期、下拉、复选框和图片控件。
- [ ] `fill_template` 接收 key-value map，原子填充并返回缺失/重复 tag。
- [ ] 禁止在 tag 不唯一时猜测目标。

### W-13 样式治理

- [ ] 获取文档已用样式和异常直格式。
- [ ] 将选定段落应用到既有样式。
- [ ] 标题层级规范化、正文格式统一。
- [ ] 提供 dry-run：列出会受影响的段落及数量。

### W-14 目录和字段

- [ ] 插入/更新目录。
- [ ] 更新字段和图表目录。
- [ ] 插入分页符、分节符、页码。
- [ ] 更新后验证目录条目与标题结构一致。

### W-15 页眉页脚与页面设置

- [ ] 页面方向、大小、边距和分节设置。
- [ ] 页眉页脚文本和页码。
- [ ] 首页不同、奇偶页不同。
- [ ] 该能力必须按 section 精确寻址。

### W-16 超链接和交叉引用

- [ ] 读取/插入/修改超链接。
- [ ] 标题、书签、脚注、尾注和题注交叉引用。
- [ ] 验证链接目标存在。

### W-17 图片与图形

- [ ] 列出图片、尺寸、替代文本和所在段落。
- [ ] 从 User Space 本地文件插入图片，不默认访问网络 URL。
- [ ] 图片 bytes 通过浏览器内部对象/安全 Base64 流转，不经过 Agent 文本上下文。
- [ ] 支持替代文本、尺寸、浮动/行内布局。

### W-18 文档元数据

- [ ] 标题、主题、作者、关键词和自定义属性。
- [ ] 修改前后返回明确 diff。

## 7. P1：Excel 报表制作

### X-11 图表完整管理

- [ ] 查询图表数据源、系列、轴、图例、标签、颜色和位置。
- [ ] 修改/删除现有图表。
- [ ] 设置轴标题、数值格式、图例位置、数据标签和网格线。
- [ ] 趋势线及其参数。
- [ ] 图表操作按名称/ID + 属性 fingerprint 定位。

### X-12 条件格式

- [ ] 读取现有条件格式规则。
- [ ] 新增、修改、删除色阶、数据条、图标集和公式规则。
- [ ] 规则优先级和 stop-if-true 语义必须可验证。

### X-13 数据验证

- [ ] 下拉列表、数字/日期范围和自定义公式验证。
- [ ] 返回验证规则、错误提示和影响区域。
- [ ] 写值前可选择验证输入是否满足规则。

### X-14 命名区域

- [ ] 列出、创建、修改和删除 workbook/sheet scoped names。
- [ ] 公式、图表和 Skill recipe 优先使用命名区域增强可读性。
- [ ] 检测重名和失效引用。

### X-15 格式化表格

- [ ] `format_as_table` 作为当前运行时优先方案。
- [ ] 表头、条纹、汇总行和 AutoFilter。
- [ ] `ListObject` 相关能力先做版本/许可证 canary；官方文档标记部分能力为付费且晚于当前 9.3 基线，不直接承诺。

### X-16 Pivot 能力

- [ ] 先支持列出、读取配置和刷新现有 Pivot。
- [ ] 创建/重构 Pivot 单独做 feasibility spike。
- [ ] 验证 compact browser runtime 和社区版是否包含需要的 API。

### X-17 评论与批注

- [ ] 列出单元格评论、添加、回复、解决和删除。
- [ ] 评论 locator 必须包含 sheet + cell。

### X-18 超链接

- [ ] 读取/设置/删除单元格超链接。
- [ ] 验证外链协议和内部 sheet/range 目标。

### X-19 保护

- [ ] 读取 sheet/range 保护状态。
- [ ] 锁定/解锁范围和受保护区域。
- [ ] 不通过 Agent 文本参数传递明文密码；需要独立安全设计。

### X-20 页面和打印设置

- [ ] 方向、边距、打印区域、重复标题行列、网格线和分页。
- [ ] 配合现有 OnlyOffice 打印链路做真实 PDF 验证。

### X-21 图片和形状

- [ ] 从 User Space 插入本地图片。
- [ ] 列出、定位、移动、缩放和删除图片/形状。
- [ ] 禁止自动从公共网络抓取未授权资源。

### X-22 工作簿变更摘要

- [ ] 每项任务返回：修改 sheet、区域、cell 数、公式数、图表数和警告。
- [ ] 可生成用户可读的“改了什么”摘要，但正文/单元格明细默认不写入服务端日志。

## 8. P2：Word 高级能力

- [ ] **W-19 模板生成**：按内容控件、书签和样式生成合同、报告、函件。
- [ ] **W-20 邮件合并**：本地数据源到模板，先支持预览和少量文档，限制批量规模。
- [ ] **W-21 脚注/尾注**：读取、插入、修改和交叉引用。
- [ ] **W-22 题注与图表目录**：图片/表格题注、交叉引用、更新 TOF。
- [ ] **W-23 修订决策**：按 locator 接受/拒绝修订；必须用户确认并有真实 E2E。
- [ ] **W-24 文档比较**：限定本地两文件比较；先确认 OnlyOffice browser runtime 可行性。
- [ ] **W-25 水印与合规标记**：插入/读取/更新水印和敏感级别标签。
- [ ] **W-26 可访问性检查**：标题层级、图片替代文本、表格标题、链接文本和阅读顺序。

## 9. P2：Excel 分析能力

- [ ] **X-23 数据画像**：空值、重复、类型分布、异常值和唯一值摘要，结果分块返回。
- [ ] **X-24 数据清洗 recipe**：trim、类型转换、去重、缺失处理，先 dry-run 再 batch。
- [ ] **X-25 公式模式分析**：识别断裂公式、硬编码异常和跨行不一致。
- [ ] **X-26 依赖/引用检查**：公式引用错误、循环依赖和失效命名区域；先做 API feasibility spike。
- [ ] **X-27 报表 recipe**：原始数据 → 清洗表 → 汇总表 → 图表 → 验证收据。
- [ ] **X-28 Dashboard recipe**：多个图表统一布局、样式和数据源检查。
- [ ] **X-29 多 Sheet 数据组合**：只通过受限区域读写实现，不引入第二个转换/执行引擎。
- [ ] **X-30 CSV 导入参数**：分隔符、编码、日期/数字解析策略与预览确认，仍走 x2t-wasm。
- [ ] **X-31 ListObject 9.4+ 能力**：仅在完成 runtime 升级、许可证确认和 bundle canary 后进入产品支持。

## 10. Skill 设计待办

### S-01 拆分 Protocol Skill 和 Recipe Skills

- [ ] `onlyoffice-core`：协议、能力查询、错误、事务和验证规则。
- [ ] `word-review`：审阅、评论、修订、精确替换。
- [ ] `word-format`：样式、标题、段落、表格和目录。
- [ ] `word-template-fill`：内容控件/书签模板填充。
- [ ] `excel-clean`：数据画像、清洗、去重和类型修复。
- [ ] `excel-model`：公式、重算、错误检查和引用验证。
- [ ] `excel-report`：表格、条件格式、图表和打印布局。

不建议让 Agent 同时加载全部 recipe；应根据用户意图延迟选择。

### S-02 标准执行循环

每个 recipe 固定遵循：

1. Discover capabilities。
2. Inspect structure。
3. Narrow target。
4. Produce dry-run/change plan。
5. Validate preconditions。
6. Apply one atomic batch。
7. Save once。
8. Verify affected region and invariants。
9. Return operation receipt。

### S-03 风险分级

- [ ] 低风险：读取、添加评论、追加非破坏内容。
- [ ] 中风险：精确替换、格式化、公式写入、插图表。
- [ ] 高风险：全文替换、删除段落/行列/sheet、排序、接受修订、覆盖旧格式文件。
- [ ] 高风险操作必须先返回影响数量和样本，并获得用户确认或满足用户已明确给出的具体范围。

### S-04 Skill 评测集

- [ ] 为每个 recipe 建立 10–20 个真实办公任务。
- [ ] 同时评估成功率、误改率、额外修改数、轮次、耗时和保存次数。
- [ ] 包含歧义目标、重复文本、隐藏 sheet、合并单元格、旧格式和外部并发修改。
- [ ] 以最终文件内容为准，不以 Agent 自述成功为准。

## 11. 持续工程化待办

- [ ] **E-01 Schema 生成**：TypeScript operation 类型、runtime parser、CLI help、capabilities 和 Skill 文档由同一 schema 生成。
- [ ] **E-02 Contract tests**：每个新 operation 至少有 validation、plugin、executor、broker 和 E2E 五层证据中的适用部分。
- [ ] **E-03 Runtime canary**：对实际 Host bundle 调用关键 API，不只搜索字符串签名。
- [ ] **E-04 Version matrix**：记录 OnlyOffice editor API、x2t-wasm、onlyoffice-browser 和 派活 的兼容组合。
- [ ] **E-05 许可证门禁**：付费/社区能力必须在 capability 中明确，构建时禁止误宣称。
- [ ] **E-06 性能预算**：大文档、10 万行表格、多图表工作簿的打开、读取、修改、保存和内存阈值。
- [ ] **E-07 隐私测试**：正文、单元格值和文件 bytes 不进入 Server 日志、错误栈或 telemetry。
- [ ] **E-08 操作审计**：只记录必要元数据、影响范围和 hash；用户可查看任务变更摘要。
- [ ] **E-09 Release flow**：onlyoffice-browser 先提交、构建 Host bundle、测试、发布 npm，再更新 派活 manifest。
- [ ] **E-10 文档同步**：产品文档、Skill、CLI capabilities 和用户可见帮助保持版本一致。

## 12. 推荐首批迭代

### Iteration 1：可信编辑事务

建议先做：F-01、F-02、F-03、F-04、F-05、F-08。

完成标准：可以证明一次复杂写入要么完整保存并验证，要么不留下部分结果。

### Iteration 2：Word 精确编辑

建议做：W-01、W-02、W-03、W-04、W-06、W-08。

完成标准：Agent 能在重复文本和多段落文档中稳定修改指定位置，不依赖用户光标/选区，也不扩大为全文替换。

### Iteration 3：Excel 数据处理

建议做：X-01、X-02、X-03、X-04、X-05、X-08、X-10。

完成标准：Agent 能读取大型表格的必要区域，精确写值/公式、排序和格式化，并证明行关系、公式结果和非目标区域未被破坏。

### Iteration 4：日常报告

建议做：W-09/W-10/W-12/W-13，以及 X-11/X-12/X-14/X-20。

完成标准：覆盖“模板填充、表格整理、数据报告、图表和打印布局”四类高频办公任务。

## 13. 官方能力依据与版本注意事项

- OnlyOffice 插件通过 `executeMethod` 和 `callCommand` 与编辑器交互；当前桥接采用的技术方向与官方插件模型一致。
- 官方 `ApiDocument` 已提供段落、标题、表格、书签、内容控件、评论、修订报告、样式、统计、目录和结构遍历能力，为 Word 扩展提供了较大空间。
- 官方 `ApiWorksheet`/`ApiRange` 已提供区域、排序、AutoFilter、图表、命名区域、Pivot 查询/刷新、行列尺寸和页面设置等能力。
- 当前产品基线锁定 9.3 系列 x2t/runtime；最新官方文档中的 9.4 `ListObject` 等能力不能直接视为当前可用。
- 官方文档将部分 `ListObject` 能力标记为付费版本；必须先做运行时和许可证 canary。

参考：

- [ONLYOFFICE：How to call methods](https://api.onlyoffice.com/docs/plugin-and-macros/interacting-with-editors/overview/how-to-call-methods/)
- [ONLYOFFICE：ApiDocument](https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiDocument/)
- [ONLYOFFICE：ApiParagraph](https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiParagraph/)
- [ONLYOFFICE：ApiTable](https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiTable/)
- [ONLYOFFICE：ApiWorksheet](https://api.onlyoffice.com/docs/office-api/usage-api/spreadsheet-api/ApiWorksheet/)
- [ONLYOFFICE：Office API changelog](https://api.onlyoffice.com/docs/office-api/more-information/changelog/)

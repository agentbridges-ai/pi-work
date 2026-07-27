# OnlyOffice 本地字体资产

派活的 OnlyOffice browser runtime 需要一组预生成字体资产，包含
`AllFonts.js`、字体缩略图、字体文件和 `font_selection.bin`。项目默认读取：

```text
fonts/
  onlyoffice-browser/  # 生成后的 OnlyOffice 字体资产
```

## 目标字体

常用 Office 文档优先覆盖这 10 类字体：

| 序号 | 字体 | 语言 |
| -: | --- | --- |
| 1 | Aptos | 英文 |
| 2 | Calibri | 英文 |
| 3 | Arial | 英文 |
| 4 | Times New Roman | 英文 |
| 5 | Cambria | 英文 |
| 6 | Microsoft YaHei / 微软雅黑 | 中文 |
| 7 | SimSun / 宋体 | 中文 |
| 8 | DengXian / 等线 | 中文 |
| 9 | SimHei / 黑体 | 中文 |
| 10 | KaiTi / 楷体 | 中文 |

macOS 的具体可用字体取决于系统版本、Office 是否安装，以及可下载字体是否已经
下载到本机。准备脚本会尽量收集上表字体；若精确字体不存在，会额外收集
`Songti`、`STHeiti`、`SimSong`、`Hei`、`Kai`、`Kaiti` 等本机 CJK 字体作为
OnlyOffice 中文 fallback。

## 生成

```bash
make prepare-onlyoffice-fonts
```

该命令会：

1. 优先从 Microsoft Office app bundle 的 `Contents/Resources/DFonts` 收集字体，
   然后扫描 `~/Library/Fonts`、`/Library/Fonts`、`/System/Library/Fonts`、
   `/System/Library/Fonts/Supplemental` 和 Apple Font MobileAsset 目录。
2. 写入临时 source cache。
3. 使用 `onlyoffice/documentserver:9.3.0` 的官方字体生成器生成
   `fonts/onlyoffice-browser/`。
4. 运行 OnlyOffice 字体资产校验。

默认使用 `zh-core` 精简字体集。Office bundle 字体存在时，生成资产会保留常见
Office 英文字体和简体中文字体，同时避免把大量系统 fallback 字体打包进仓库。
需要调试广覆盖字体集时可以运行：

```bash
PIWORK_ONLYOFFICE_BROWSER_FONT_SET=full make prepare-onlyoffice-fonts
```

默认不会把 source cache 写入仓库。需要调试字体收集结果时可以显式保留：

```bash
PIWORK_ONLYOFFICE_FONT_SOURCE_CACHE_DIR=fonts/source-cache make prepare-onlyoffice-fonts
```

## 开发字体策略

开发环境的字体下拉固定为这 10 个主字体，顺序也固定：

```text
Aptos
Calibri
Arial
Times New Roman
Cambria
Microsoft YaHei
SimSun
DengXian
SimHei
KaiTi
```

`make dev`、`make build` 和 `make onlyoffice-browser` 会校验
`fonts/onlyoffice-browser/sdkjs/common/AllFonts.js` 中的
`__fonts_visible_names` 必须严格等于上表。`Microsoft YaHei UI`、`NSimSun`、
`SimSun-ExtB`、`Cambria Math`、`FangSong` 等别名或补充字体仍保留在
OnlyOffice 字体注册表中，用于打开已有文档，但不会出现在字体下拉里。

另外，项目会隐藏注册这些 Office 符号/公式字体，用于列表项目符号、插入符号和
公式解析：

```text
Bookshelf Symbol 7
Marlett
Monotype Sorts
MS Reference Specialty
MT Extra
Segoe UI Symbol
Symbol
Webdings
Wingdings
Wingdings 2
Wingdings 3
```

它们必须存在于 `__fonts_infos` 中，但不能出现在 `__fonts_visible_names` 中。

## 项目默认路径

`make dev` 和 `make build` 默认使用 `fonts/onlyoffice-browser/`。如果该目录不存在
或校验失败，普通开发启动会直接失败并提示维护者重新生成；不会在其他开发者机器上
隐式二次转换字体。

也可以显式覆盖：

```bash
PIWORK_ONLYOFFICE_BROWSER_FONT_SOURCE_DIR=/path/to/fonts \
PIWORK_ONLYOFFICE_BROWSER_FONT_ASSETS_DIR=/path/to/generated \
make onlyoffice-browser
```

## 授权

字体文件通常有独立授权。即使仓库是闭源，也请在提交 `fonts/source/` 或
`fonts/onlyoffice-browser/` 下的字体二进制和生成资产前确认团队拥有相应的开发、
分发或内部共享授权。日常 clone 后只需要已有的 `fonts/onlyoffice-browser/`。

# All-in-One Paperwork Agent Workspace

一站式Paperwork Agent工作台

派活 是一个本地多用户Agent工作台。用户通过 Better Auth 邮箱密码登录或注册，认证数据存放在外部 Postgres；派活 的 session、workspace、Pi 会话和录制数据隔离在仓库根目录 `data/` 下。最终 Agent 运行时只使用 `@earendil-works/pi-coding-agent@0.82.1` 的原生 `rpc-entry`，没有兼容 transport、SDK proxy、其他 Pi fork 或 provider 回退路径。

产品定位是 paper work：文档、表格、演示文稿、资料检索与日常办公是用户可见的主流程。Pi 的原生 Agent 能力在隔离会话工作区内完成任务；编码是实现手段，不是 派活 提供 Git、worktree、PR 或宿主开发终端等专用产品界面的理由。User Space 内的 just-bash/Wterm 继续作为浏览器沙箱中的文件与文档操作能力。

## 架构

```text
Browser
  -> Caddy (the only published Compose port)
  -> Web: Bun/Hono API + browser WebSocket
  -> Better Auth + Postgres (backend network)
  -> private Unix JSONL/HMAC Runtime control socket
  -> Runtime: one Node + native Pi rpc-entry per session in SRT
  -> explicit trusted Piwork Pi extension
```

On macOS, the Linux development runtime is an [OrbStack](https://orbstack.dev/)
Linux machine. On Windows, it is a WSL2 Linux distribution. The browser, IDE,
and Chrome extension remain on the host, but Bun, Node, SRT, Pi, Postgres, the
repository checkout, and `data/` run inside Linux. Do not run `make dev` from a
native macOS or Windows shell.

- **认证**：Better Auth 原生接口挂在 `/api/auth/*`，派活 保留 `/api/auth/mode` 和 `/api/me` 给应用层使用。
- **用户/组织隔离**：tenant 是文件系统隔离边界；`org_nodes` 只提供 RBAC 范围。会话目录为 `data/tenants/<tenantId>/users/<userId>/sessions/<sessionId>/`，创建时固定 `membershipId` 与 `orgNodeId`。
- **会话数据**：每个 session 固定使用 `workspace`、`home`、`tmp`、`pi-config`、`pi-sessions`、`recordings`、`user-space-checkouts` 和 `session.json`。Pi JSONL 是对话、模型、压缩、Plan 和 Todo 的唯一真源。
- **启动约束**：Pi 至少带 `--no-builtin-tools --no-extensions --no-skills --no-prompt-templates --no-themes --no-approve`，然后只显式加载 派活 trusted extension 和平台受管 Skills；工作区 `.pi`、项目扩展、包安装和 `/login` 均不可用。
- **凭据**：模型与 MCP capability 由服务端通过一次性 Unix socket bootstrap 交给扩展并在消费后销毁。凭据不进入 argv、磁盘、shell env、日志、录制或 Pi JSONL；子 Agent 使用独立的一次性通道。

## 快速开始

依赖：

- mise `2026.8.2`，用于安装和激活仓库锁定的开发工具
- Bun 1.3.9 和 Node.js >= 22.19.0
- 外部 Postgres，并通过 `DATABASE_URL` 暴露连接串
- `make install` 会安装精确锁定的 `@earendil-works/pi-coding-agent@0.82.1`、`@modelcontextprotocol/sdk@1.29.0` 与 `@anthropic-ai/sandbox-runtime@0.0.65`
- Linux 的 SRT 还需要 `bubblewrap`、`socat`、`ripgrep` 及可用的 unprivileged user namespace；这些依赖必须安装在 OrbStack/WSL2 Linux 内
- Linux 通过真实 Pi RPC smoke 和中性 `user-space.piwork.internal` 受保护文件传输 canary 验证 SRT；该通道不承载模型流量
- 当前只有 Linux SRT 提供可验证的后代进程生命周期隔离；宿主 macOS/Windows 只提供浏览器和开发工具，不运行 Agent session
- 最新版桌面 Chrome、Microsoft Edge 或其他 Chromium 浏览器；Safari、Firefox、手机和平板不受支持

```bash
# 在 OrbStack Linux、WSL2 Linux 或原生 Linux 终端内执行
mise trust
make mise-install
make install
# Compose 会生成 0600 配置、Runtime HMAC key、数据库应用角色 secret
make selfhost-init
make dev
```

打开脚本输出的 Frontend URL，使用邮箱密码注册或登录。

`mise.toml` 和 `mise.lock` 是开发工具环境的来源。`make mise-install` 会安装
Piwork 使用的精确 Bun/Node.js 版本；PostgreSQL 客户端版本仍由
`mise.toml` 提供，需要时可执行 `mise install --locked`。交互式 shell 可按
mise 的说明执行 `eval "$(mise activate zsh)"`（Bash 使用 `bash`），这样进入
仓库目录时会自动激活锁定版本。`.tool-versions` 仅作为 asdf 兼容镜像，修改
工具版本时必须与 `mise.toml` 同步。

生产服务默认使用稳定地址 `http://127.0.0.1:3457`。当 Chromium 完成安装条件检查后，工作台会显示“安装桌面应用”；安装版以独立窗口运行。断线页不会缓存或展示账号、会话或文件数据。

## 常用命令

```bash
make install
make mise-install
make auth-generate
make auth-migrate

make dev
make dev-fast
make dev-fast-stop
make dev-native
make selfhost-doctor
make selfhost-release-validate  # release manifest 已填充时执行
make selfhost-up
make selfhost-down
make selfhost-backup
make selfhost-restore BACKUP=/path/to/backup
make selfhost-upgrade
make status
make agent-browser-e2e

make typecheck
make test-targeted
make test
make build
make verify-pi-versions
make verify-pi-only-runtime
make test-pi-rpc-contract
make test-srt-pi

make pi-reset-legacy-sessions
CONFIRM_PI_SESSION_RESET=1 make pi-reset-legacy-sessions
CONFIRM_PI_SESSION_RESET=1 CONFIRM_EXTERNAL_PI_DATA_ROOT=1 make pi-reset-legacy-sessions
CONFIRM_HARD_RESET=1 make dev-reset-sessions-hard
```

`make dev` 必须在 OrbStack Linux、WSL2 Linux 或原生 Linux 内执行，会启动固定 Compose source 栈：

- Caddy: `http://127.0.0.1:3457`（唯一发布端口）
- Web/Runtime/Postgres: 仅在 Compose 网络和共享 Unix socket 内部可见
- Vite HMR: source 栈内部通过 Caddy 提供
- 数据卷：Linux Runtime 内的 `data/`

`make dev-native` 保留原生 Linux 的进程内 Pi debug 路径；它不关闭 SRT。Compose
在 `selfhost doctor --require-verified` 和 nested-SRT canary 未通过时会停止并拒绝就绪。

更多细节见 [docs/development.md](docs/development.md)。

## Chrome Agent 桥接

派活 默认给新会话使用 **Agent** 模式，另保留只规划不执行的 **Plan** 模式。网页操作不引入第三种逐次审批模式：Agent 通过固定版本的
`agentbridges-ai/agent-browser` Chrome 扩展 provider 接入用户当前的桌面 Chrome，页面动作走结构化 CDP，动作后必须做页面语义回读。

`make dev` 会准备固定提交的运行组件。首次使用时点击工作台标题栏的浏览器图标，启动桥接，然后按面板提示在
`chrome://extensions` 中加载已解压扩展。发布前可运行 `make agent-browser-e2e`，它只接受真实扩展连接，不会回退到 mock CDP。

Office 编辑器 Host 与字体、SDK、WASM 等静态资源由独立部署的
`onlyoffice.getpi.work` 提供。Piwork 只使用已发布的
`@agentbridges-ai/onlyoffice-browser` 客户端 API；`make dev` 和
`make build` 不准备、校验或托管 repo-local OnlyOffice 资源。

## 状态权威来源

- Better Auth + Postgres 是唯一认证来源。
- Better Auth `user.id` 是本地隔离 ID，并继续填入 app 内部 `CurrentUser.uuid` 字段。
- 服务端状态保存在 `data/tenants/<tenantId>/users/<userId>/...`；frontend 不把 session/员工状态写成浏览器权威缓存。
- session 权威路径是 `data/tenants/<tenantId>/users/<userId>/sessions/<sessionId>/...`；跨 tenant、用户和 session 不能枚举或路由。
- `session.json` 只保存产品 authority、归档、Pi 相对路径、离线队列和客户端去重；不会复制消息历史或 pending permission。
- provider credentials 不由 派活 持久化；短生命周期 bootstrap 只在内存中注册允许的 Pi provider。

## 用户空间挂载

用户本机目录是浏览器授权的虚拟挂载，不作为真实 server cwd 暴露。Pi 通过会话内置 `user-space` CLI 和受管 Skill 按需访问目录。

- 每个挂载目录支持 `readonly` / `readwrite`，CLI broker 和浏览器执行层都会校验 `canWrite` 后才允许写入、替换或删除。
- 浏览器 File System Access API 负责授权和 handle 遍历；浏览器 Worker 内的 TypeScript index 负责完整 metadata indexing、展示/检索过滤、分页和搜索。
- 底层索引完整枚举用户授权目录，不按深度、dot-prefixed hidden 路径、目录名或文件大小过滤；`.git`、`node_modules`、`dist` 等目录也进入索引。
- UI 文件树和默认搜索会隐藏 dot-prefixed 路径；用户可分别通过个人设置开启显示隐藏项和检索隐藏项。
- 内容索引仅在浏览器 Worker 运行时预读 file-tree 默认白名单：`txt`、`js`、`ts`、`css`、`html`、`json`。其他文件内容只在 preview、`read_file`、blob checkout/checkin 或写冲突校验时读取。
- Agent 顶层只暴露 pi 对齐的 `user-space read/write/edit/bash`。递归内容搜索由 bash 内的 `grep -r/-R` 委托浏览器 file-tree 索引，递归路径匹配由 bash 内的 `glob 'PATTERN' [PATH]` 完成，`find/tree` 负责 metadata 遍历；`search/search_paths/glob` 仅为内部 operation。
- 文本通常直接远程读写编辑；二进制通过 bash 内的 `checkout/checkin` 显式双向传输，固定进出 `workspace/shared` 与 `user-space:/shared`。私有 staging 位于 session 的 `user-space-checkouts`，不会作为宿主路径暴露给 Agent。

## 原生 Pi RPC

浏览器只接受 Pi 化协议：`agent_message`、`message_delta`、`tool_execution`、`interaction_request/response`、`run_state` 和 `history_snapshot`，并保留 `seq/ack/replay`、会话阶段与 User Space 语义。服务端与 Pi 子进程之间只使用带 request ID 的严格 LF JSONL，处理合并/分片帧、背压、超时、帧与 stderr 上限、进程代际、退出 pending 清理、abort/retry/compaction 和 history replay。

`ready` 只有在 `get_state`、模型列表、精确 JSONL 历史恢复、trusted extension 模式和受管 MCP 状态全部完成后才成立。完整契约见 [docs/pi-rpc.md](docs/pi-rpc.md)。

平台模型白名单、Agent 的 `provider/model` glob 白名单、已注入凭据和网络策略会做交集。`GET /backends/pi/models?agentId=...` 通过短生命周期受控 Pi RPC probe 返回可用模型，不返回任何凭据。

运行模式仅有 `agent` 和 `plan`。Plan 模式不注册 `write`/`edit`，子任务强制只读，MCP 只暴露明确标记为 `readOnly` 的工具，bash 对重定向、动态执行和无法分类的语法 fail closed。`ask`、`todo_write`/`todo_read`、`task`、`propose_plan` 与 `mcp__<server>__<tool>` 都由 trusted extension 和服务端受管 broker 提供。后台 `task` 以 Pi 原生 `agent_settled` 为终态，可通过 `list/status/wait/steer/stop` 管理，并用 Pi 原生 `prompt` 的 `followUp` 流式行为将有界结果送回父会话；不会加载第二套 Agent runtime。

## 代码目录

- `web/src/`：React 工作台、状态管理、API/WS 客户端和 UI 组件。
- `web/server/index.ts`：本地 Bun/Hono 入口和经过认证的 API/WS 路由。
- `web/server/better-auth.ts`：Better Auth + Postgres 配置。
- `web/server/local-auth.ts`：Better Auth session 到 派活 用户上下文的适配层。
- `web/server/local-*`：data 路径、用户隔离和 runtime registry。
- `web/server/pi-adapter.ts`、`pi-rpc-transport.ts`：Pi 浏览器适配与严格 JSONL 子进程 transport。
- `web/server/pi-bootstrap-channel.ts`：一次性内存凭据 bootstrap。
- `web/server/managed-mcp.ts`：stdio、SSE 和 Streamable HTTP 的受管 MCP。
- `web/server/session-store.ts`：精简的 `session.json` 产品 authority。
- `scripts/`：本地开发和维护脚本。
- `docs/`：开发和架构文档。

## License

MIT

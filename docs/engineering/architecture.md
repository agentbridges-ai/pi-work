# 架构、代码与边界

- Server、Browser、Shared 和 Landing 保持单向依赖；Shared 不导入运行时实现。
- Better Auth `user.id` 是产品隔离 ID；Session 目录和 Pi JSONL 是运行态权威。
- Piwork 不构建产品级 Git、Worktree、PR、宿主 PTY 或替代 Agent runtime。
- 认证、隔离、凭据、Pi RPC/SRT、Trusted Extension、User Space Shell 和 OnlyOffice 集成属于高风险路径。
- 新模块必须有 manifest、冻结安装、测试入口和 Owner；未完成这些条件不得通过相对路径“临时导入”。

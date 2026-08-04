# 安全策略

## 报告漏洞

请使用 GitHub 的 [Private Vulnerability Reporting](https://github.com/agentbridges-ai/pi-work/security/advisories/new) 私下报告漏洞。不要在公开 Issue、PR、日志、录制文件或讨论中披露可利用细节。

报告应包含受影响版本、复现步骤、影响范围、临时缓解措施和安全联系方式。Owner 目标是在 3 个工作日内确认收到报告，在 7 个日历日内完成初步分级；目标修复时限为 Critical 7 日、High 30 日、Medium 90 日，Low 进入后续发布计划。

## 运行时安全边界

- Better Auth + Postgres 是唯一产品认证路径。
- 用户隔离路径必须保持在 `data/<betterAuthUserId>/<sessionId>/` 下。
- 凭据只能通过根 `.env` 或一次性 Bootstrap channel 注入；不得出现在 argv、日志、录制、Pi JSONL 或子进程环境中。
- Pi 只允许仓库声明的 native runtime、trusted extension 和受治理 MCP。
- 安全例外必须登记并在 30 日内过期；无到期日的例外无效。

## 支持范围

默认支持 `main` 最新发布及前一个 SemVer minor。只要漏洞仍影响受支持版本，报告都会进入处理队列。

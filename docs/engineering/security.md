# 安全、依赖与供应链

供应链门禁覆盖 Bun lockfile、GitHub Actions、CodeQL、Dependency Review、Secret Scanning、Push Protection、License 清单和发布 SBOM。High/Critical 发现必须修复或登记短期例外，不得无限期忽略。

生产凭据不进入 Git、argv、日志、录制、Pi JSONL 或 Agent 子进程环境。安全报告使用 `SECURITY.md` 指定的 PVR 通道。新增网络、MCP、文件系统或外部运行时能力必须先完成威胁分析和高风险评审。

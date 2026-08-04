# 运行、日志、指标与恢复

结构化 Logger 是运行态日志唯一入口，必须脱敏并关联 requestId；CLI 帮助和测试可以使用显式 allowlist。Metrics/Diagnostics 只对拥有 `runtime:view` 的租户成员开放。

Piwork 当前是 local-first 产品，没有统一 hosted SLO 或 error budget。Bundle budget、CI 稳定性、备份完整性和恢复演练是当前可度量控制。真正的 RTO/RPO、告警渠道和多节点容量指标在 hosted 运行面出现后通过 RFC 定义。

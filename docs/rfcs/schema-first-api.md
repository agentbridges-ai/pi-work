---
owner: piwork-core
status: proposed
last_reviewed: 2026-08-04
review_cycle_days: 90
---

# RFC：Schema-first HTTP 合约

定义新旧 HTTP DTO 的 runtime validation、错误结构和生成/兼容策略；当前阶段只要求新改动复用 `web/shared` 类型，不在治理基线中批量转换现有 API。

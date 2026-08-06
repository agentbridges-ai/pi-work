---
owner: Misakago
status: accepted
last_reviewed: 2026-08-06
review_cycle_days: 30
---

# ADR-0006：Leader-only Bootstrap 自动审计与签名切换

## Context

Piwork 当前只有一名显式 Core reviewer：`@Misakago`。治理不能因为团队尚未完成组建而
永久把 Leader 变成无条件 bypass，也不能读取组织成员清单来猜测未来 Core 身份。与此同时，
Leader 作者的 0 个额外审批、其他作者（含 Dependabot）的 Leader 当前 head 一票，以及
非 Leader Core 的双审目标必须保持不变。

## Decision

`.governance/github-policy.json` 的 `bootstrap` 明确记录 `leader-only` 状态、
`non-leader-core-review` 范围、起始日、90 天期限和三名显式 Core 身份的切换阈值。
Bootstrap 只影响非 Leader Core 作者路径；allowlist 不足以提供两名非作者 Core 时，
`governance-review` 继续 fail-closed。Leader 作者、社区作者和低风险 Dependabot 的规则
不因 Bootstrap 改写。

`.github/workflows/governance-bootstrap-audit.yml` 在 trusted `main` 上以 read-only 权限
运行 PR/merge group、main push、schedule 和 workflow dispatch 审计。它只读策略、显式
allowlist、PR 元数据、工作流权限声明和 Ruleset readback；PR token 不查询仅管理员可读的
Actions 权限或 legacy branch-protection 端点，仓库级 Actions/legacy protection readback
只由显式管理员治理工具执行；
不修改 policy、Team、Ruleset、Issue、Review 或 PR。docs-only PR 与 merge group 没有可用的
作者感知数据时仍产生确定的 no-op/审计状态。过期、范围扩大、未知 state、Core allowlist
达到 3 人或远端 reviewer 漂移均报告失败并要求人工收口。

当团队达到三名显式 Core 身份或 Bootstrap 到期时，Leader 必须提交本机 Good signature
的策略 PR，把 `enabled/state` 明确迁移到 `full-core` 并同步 allowlist；该转换不是机器人
静默写入，也不构成 bypass。若转换数据不足，审计继续 fail-closed。

## Consequences

单人阶段仍可顺畅合并 Leader、社区和低风险 Dependabot 变更，同时非 Leader Core 路径不会
因猜测成员而放宽。定时审计会在三人或 90 天边界触发可见失败，促使 Core 团队通过签名 PR
完成治理升级。签名、线程解决、实际最后 pusher、全部 required checks 和高风险 Leader
参与仍由原有 Ruleset/`governance-review` 强制。

## Verification

`scripts/governance/bootstrap-audit-fixtures.mjs` 覆盖健康、过期、期限扩大、三人阈值、
full-core 签名切换、Ruleset reviewer 漂移和 docs-only no-op；`make governance-check` 将其
与现有治理 fixture 一起运行。

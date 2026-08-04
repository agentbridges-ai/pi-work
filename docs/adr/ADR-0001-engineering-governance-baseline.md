---
owner: Misakago
status: accepted
last_reviewed: 2026-08-04
review_cycle_days: 90
---

# ADR-0001：工程治理基线

## Context

Piwork 由 Leader/Owner、约五人的 Core Team 和社区贡献者共同维护；认证、隔离、原生 Pi 和 User Space 边界需要高于普通 UI/文档改动的审查强度。

## Decision

普通改动需要一名 Core 审批；高风险改动需要两名 Core 审批和 Leader 参与。现有技术债使用机器化例外和 ratchet 管理，持续交付使用可审计的 Squash、SemVer 和 Release evidence。

## Consequences

初期 Core 人数不足时高风险 PR 可能需要临时 PR-only bypass；该 bypass 必须有原因和短期跟踪项。后续核心成员通过 GitHub Team 增加，不修改每条 CODEOWNER。

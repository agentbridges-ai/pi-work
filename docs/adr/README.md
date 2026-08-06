# ADR

ADR 文件使用 `ADR-NNNN-短标题.md`，说明 Context、Decision、Consequences、Rejected Alternatives 和验证证据。

当前治理 ADR：

- `ADR-0001-engineering-governance-baseline.md`：Owner、Core Team、风险分级评审和 ratchet。
- `ADR-0002-stacked-prs-and-merge-queue.md`：Stacked PR 依赖链、merge_group required status 合约和延后启用的 Merge Queue 建议。
- `ADR-0003-leader-self-approval-policy.md`：Leader 作者身份计入一次审计、非 Leader Core 双审和 trusted-base 治理检查。
- `ADR-0004-dependabot-leader-review.md`：Dependabot 窄范围低风险更新由 Leader 单独审批，current-head 约束由 `governance-review` 执行，签名/状态门禁仍有效。
- `ADR-0005-governance-review-native-ruleset.md`：native Ruleset 取消固定 Team/CODEOWNER 审批，由 trusted `governance-review` 负责作者感知计数，安全门禁仍保留。
- `ADR-0006-leader-only-bootstrap-audit.md`：单人阶段只对非 Leader Core 路径做 90 天/三人阈值审计，切换必须通过签名策略 PR。

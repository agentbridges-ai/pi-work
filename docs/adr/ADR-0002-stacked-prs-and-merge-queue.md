---
owner: Misakago
status: accepted
last_reviewed: 2026-08-05
review_cycle_days: 30
---

# ADR-0002：Stacked PR 与 Merge Queue 治理边界

## Context

Piwork 需要把分层开发的可审查性和 main 的合并安全边界同时保留下来。Stacked PR 只表达依赖关系，不应成为绕过 CODEOWNERS、author-aware governance 或高风险审查的通道。

本次专项以远端 main 的 36215b770f8abb0b59d252abe2aba74950c3193d 为只读基线。2026-08-05 的 GitHub API readback 证据如下：

- agentbridges-ai/pi-work 的 visibility 为 PUBLIC；组织计划 API 返回 free。
- GraphQL schema 中存在 repository.mergeQueue 和 MergeQueueConfiguration，但 repository.mergeQueue 当前为 null。
- REST /repos/agentbridges-ai/pi-work/rulesets?includes_parents=true 返回三个 active rulesets；/rules/branches/main 返回 required status checks，但没有 required_merge_queue。
- gh ruleset check main --repo agentbridges-ai/pi-work 返回 7 条适用于 main 的规则，包含签名、线性历史、CODEOWNER/required review 和 8 个 required checks，但没有 merge queue。
- REST /repos/agentbridges-ai/pi-work/stacks 返回 []，当前 open PR #49、#48 的 REST stack 字段为 null。GitHub Stacked PR 文档当前仍将 Stacks API 标为 private preview。
- 现有未收口 PR 包括 mise (#49)、native Pi (#48)、release (#45) 和其他 OnlyOffice/CI 变更；因此本次不启用 main 的不可逆 merge queue 规则。PR #35 已合并，且不修改任何已有 feature 分支。

参考：[GitHub merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)、[GitHub Stacked PRs REST API](https://github.github.com/gh-stack/reference/rest-api/)、[REST rulesets](https://docs.github.com/en/rest/repos/rules)。

## Decision

### Stacked PR 约定

依赖链固定为：

    main
      └── mise
            └── feature
                  └── release

- mise 层只承载工具链/基础设施前置变更，底层 PR 目标为 main。
- feature 层目标为 mise 分支的 head；它依赖 mise，但仍是独立 PR。
- release 层目标为 feature 分支的 head；只有下层 PR 已合并或被明确纳入同一合并计划后，才从下往上合并。
- 每层必须独立获得自己的 required checks、CODEOWNERS 审批、author-aware 审批和高风险审查；Stacked preview 不改变规则计算，也不提供 bypass。
- 上层 PR 不得把下层未审查的变化伪装成已审查的 main 变化；必要时拆分 PR 或等待下层收口。

### Merge Queue workflow 合约

当前 ruleset 的 8 个 required status workflow 均监听 merge_group：

- governance
- quality
- better-auth-e2e
- srt-production-canaries
- verify
- landing-quality
- dependency-review
- governance-review

merge_group 没有 pull_request 元数据，因此：

- verify/deep-verify/SRT 对合成 queue commit 运行实际验证，并显式处理空的 PR base/head；verify/deep-verify 在 staged candidate manifest 存在时使用 merge_group 的 base/head SHA 做确定性候选验证，但显式 candidate integration job 仍只允许 workflow_dispatch。
- dependency-review 的 PR-only action 和 governance-review 的 author-aware PR 检查在 merge group 上只做确定性的成功 no-op；它们原有的 PR required check 和审批仍是入队前门槛，依赖审计仍在 merge group 运行。
- deploy.yml 和 release-please.yml 不监听 merge_group，所以队列验证不会触发 Production 部署或 release automation。
- scripts/governance/merge-queue-workflows.mjs 通过 make governance-check 检查 required workflow 映射、merge_group 触发、元数据边界和生产/发布排除项。

### 延后启用与建议配置

管理员在当前未收口 PR 明确协调前不执行 apply。未来满足 apply gate 后，main ruleset 的建议配置是：

- merge method：SQUASH
- merging strategy：ALLGREEN，确保组内每个 entry 都必须通过；不选允许失败 entry 的 HEADGREEN
- 初始构建并发：1；合并批次最大/最小均为 1
- 最小批次等待：5 分钟；required-check timeout：60 分钟

启用时必须由管理员显式修改 main ruleset，并完成 REST readback 和 gh ruleset check main --repo agentbridges-ai/pi-work；本 ADR 与 .governance/github-policy.json 只记录建议和当前证据，不会隐式 apply。

## Consequences

required statuses 会在 PR 和 merge group 两种路径上稳定出现，且 queue commit 能验证组合后的变化。PR-only governance 的语义保持在入队前，生产部署和发布仍由 main push/人工 dispatch 控制。Stacked PR 目前只能作为约定记录，不能假定当前仓库已获得 preview enrollment。

## Rejected Alternatives

- 不把 merge_group 加到部署或 release workflow，避免 queue validation 产生外部部署和发布副作用。
- 不在 merge group 伪造 pull_request payload，也不在缺少 PR 元数据时执行 author-aware 审核脚本。
- 不在现有治理/mise/native/OnlyOffice/release PR 未收口时启用不可逆规则。

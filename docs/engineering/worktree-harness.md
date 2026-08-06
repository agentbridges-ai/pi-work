# Worktree Harness 开发规范

本文是 Piwork 本地并行开发的工程约束。它把执行线程的本地隔离、证据回传和
主线程收口写成可检查的契约；它不是 GitHub 审查或合并权限的替代品。

## 协调模型

主线程是唯一的用户入口、任务 DAG 和依赖编排者，也是唯一可以安排合并的
协调者。执行线程由任务 manifest 派发，每个任务独占一个 `misakago/` 分支、
一个 worktree 和一个带 TTL 的 lock。执行线程可以在自己的 manifest scope 内
继续使用 subagent、goal 或局部 harness，但不能写根 checkout、其他 worktree，
不能修改远端治理策略，也不能直接 merge Pull Request。

执行线程的结果必须回传给主线程，至少包含：task/thread/owner、commit、通过的
checks、签名状态、dirty/unpushed 状态、风险和下一步。manifest 中的
`coordination` 字段固定记录当前 milestone、证据、`root-coordinator` handoff
以及 `root-coordinator-only` merge authority。没有 milestone evidence 或
handoff 的记录会被治理检查拒绝。

用户提出新颖、可复用的开发理念时，接收它的主线程先评估适用范围，再把稳定
规则写入 `.governance/worktree-policy.json`、fixture 和本文件；后续任务从
policy 自动继承，而不是依赖某一次对话中的口头约定。每个本地 milestone 都有
稳定 id、唯一 owner、objective、entry/exit criteria、evidence、human review
时点和 blocked escalation。执行线程只能报告 evidence，不能直接关闭 milestone。
主线程负责把 issue/PR 绑定到 `agentbridges-ai/pi-work` 的 GitHub milestone 并
维护进度；当前 policy 只读声明 `Engineering Governance Baseline v1`（#1）和
`Release 0.96.0`（#2）的 number/title。执行线程不能修改或关闭这些 milestone。
harness 只校验 manifest 中的本地 milestone 与 GitHub milestone 绑定格式，不调用
GitHub 写 API。

GitHub 仓库页面的治理入口也纳入 policy：Code、Issues、Discussions、Pull requests、
Actions、Security and quality、Insights 和 Settings 都要有明确 readback；PR manifest
必须补齐 assignee、`piwork-core`/`piwork-leads` reviewer 路由、至少一个稳定 label、
milestone 和 Development 链接（tracker issue、依赖和 stacked-pr 关系）。Issues
必须有 labels/milestones/issue forms，Discussions 必须有 categories、置顶治理入口和
moderation owner，PR 必须有 template、required checks，Actions 必须有
`merge_group`/只读默认权限/SHA pinning，Security and quality 必须覆盖 PVR、Secret
Scanning、Dependabot、CodeQL 和 Dependency Review。Projects 仅作为可选视图，Wiki
不能成为第二治理事实源；Insights 只读，Settings 只允许 root-coordinator 的显式
管理员 readback/apply。harness 不直接写 GitHub，缺字段会在本地 plan/claim 失败。

### Tracker、依赖与阻塞约定

本 harness 采用 GitHub Milestone、Issue/Tracker 和 Projects 中可复用的协作语义，
但事实源固定为 GitHub milestone + tracker issue；Projects 只用于视图、汇总和
排序，不能替代 tracker。每个 task manifest 必须记录 tracker issue、goal、due
date、milestone 的 entry/exit/evidence/humanReview/blocked escalation，以及显式
依赖链接。没有前置依赖的任务也要写 `--depends-on none`；有依赖时按稳定 task 或
里程碑 id 写出链路，例如 `mise → feature → release`。并行任务应拆成 scope 不相交、
可独立审查的小 PR，而不是把多个无关目标塞进一个 claim。

标签保持少量且语义稳定，policy 当前只允许 `governance`、`feature`、`release`、
`blocked`、`needs-review`。任务进入 blocked 状态时，必须同时提供 tracker/status
更新文本和 `status-update` evidence；没有更新的 blocked claim 会被拒绝。scope
变更必须回到 root coordinator review。milestone 关闭只能由主线程或声明的 owner
完成，执行线程只能回传 evidence；`merge`、`close-milestone` 和
`complete-milestone` 命令会直接失败。policy 中的 `milestoneOps`、本地 fixture
和本文共同构成 intake 后的可复用规则，默认不读取或记录 token/secret，也不新增
远端写 API。

推进顺序是“本地机器检查和仿真 → required checks → 里程碑摘要 → 人类复核或
外部授权 → 主线程收口”。并发只在 scope 不相交时启用；相同文件和高风险路径
会自动阻断，不能靠口头约定消除冲突。最终审计使用运行时实际可用的模型和
reasoning 配置，并保留 human-in-the-loop；模型精度不改变审批要求。

### CI/CD 主线程编排契约

主线程是 CI/CD 编排器和唯一用户入口：先按变更范围与最高风险选择检查，再做
快失败，最后才跑重验证。`.governance/worktree-policy.json` 的 Gate 0–3 是不可
删除的分层门禁：

1. **Gate 0 — scope-and-risk**：manifest、`worktree-check`、风险分类和变更文件
   解析；本地失败立即停止。
2. **Gate 1 — local-fast-fail**：format、lint、typecheck、targeted tests 和
   security fixtures；能在本地仿真的错误不得留到远端。
3. **Gate 2 — remote-required-checks**：治理、质量、依赖审查、verify 和领域
   canary；按照当前提交的风险动态排列，但不减少检查。
4. **Gate 3 — combined-closeout**：Stacked PR 依赖顺序、Merge Queue 的
   `merge_group` 组合验证、release evidence 和 human review。

每个 required status 都必须产生确定结果：无关变更为受控 `deterministic-no-op`，
相关变更运行真实检查；禁止缺失状态、伪造状态和静默 bypass。旧提交只在同一
scope 的新提交出现时取消，不能取消 required evidence。Stacked PR 只表达依赖
顺序（`mise → feature → release`），每一层独立 review/check；Merge Queue 只做
最终组合验证，不替代审查。执行线程并行备料、回传 milestone/evidence，不能合并
或关闭 milestone；主线程在里程碑处汇总，最后由运行时可确认的精确模型以 ultra
推理配置审计，并保留人工收汁。

## 命令与状态

先在当前执行 worktree 内安装依赖和运行命令：

```bash
git fetch origin main
make install
make worktree-check
make governance-check
```

`scripts/governance/worktree-harness.mjs` 默认只读：

```bash
# 只规划，不创建目录、不写 manifest/lock
node scripts/governance/worktree-harness.mjs plan \
  --task-id task-123 --thread-id 019f... --owner alice \
  --branch misakago/task-123 --scope web/server/example.ts \
  --milestone local-simulation --tracker-issue 50 \
  --goal "prove isolated worktree governance" --due-date 2099-12-31 \
  --depends-on none --label governance \
  --evidence plan,worktree-check,fixtures

# 只有显式 --apply 才会创建 worktree 和写入状态
node scripts/governance/worktree-harness.mjs claim --apply \
  --task-id task-123 --thread-id 019f... --owner alice \
  --branch misakago/task-123 --scope web/server/example.ts \
  --milestone local-simulation --tracker-issue 50 \
  --goal "prove isolated worktree governance" --due-date 2099-12-31 \
  --depends-on none --label governance \
  --evidence plan,worktree-check,fixtures
```

阻塞任务另加 `--status blocked --status-update "tracker #50: waiting for ..."`，
并把 `status-update` 放入 `--evidence`；harness 会拒绝没有 tracker 更新的 blocked
状态。

可用命令是 `plan`、`check`、`claim`、`release` 和 `cleanup`。没有 `--apply` 的
`claim`、`release`、`cleanup` 都是预览。`check` 始终只读。运行状态位于共享
Git 元数据下的 `.git/piwork-worktree-harness/manifest.json` 和 `locks.json`，
不进入 Git tracked 文件；运行锁使用独占目录和 TTL，防止 cleanup 与 claim
竞态。manifest 和 lock 都必须包含 task id、thread id、owner、branch、绝对
worktree path、base SHA、scope 以及 coordination evidence。

`plan` 和 `check` 都输出 milestone；claim 需要提供当前 milestone 的 exit
evidence。handoff 的必需证据清单固定为 `commit`、`signature`、`checks`、
`dirty`、`unpushed`、`risk`、`nextAction`。这些是证据项名称和状态契约，不是
把 secret 或 token 内容写进状态文件的许可。

默认 base 是最新的本地 `origin/main` ref。若 ref 已移动，旧记录会被标记为
stale；需要显式在当前执行 worktree 内 `git fetch` 后重新 plan。可以用
`--base <ref-or-sha>` 或 `--pr <local-pr-ref>` 规划指定基线，也可以用
`--github-milestone 1|2|<stable-id>` 选择 policy 中声明的 GitHub milestone；
记录仍必须能被本地 Git 解析。harness 不替任务执行 GitHub API 写操作。

release/cleanup 只有在 worktree clean 且没有未推送 commit 时才会回收。dirty 或
unpushed 的任务会自动保留并提示下一步，不会使用强制删除掩盖数据。默认保留
本地 branch；远端 branch、commit 和 PR 的生命周期由主线程按提交、推送、建 PR、
审查、合并顺序编排。

## 隔离边界

worktree 是本地开发隔离，不是安全沙箱。所有 worktree 共享：

- Git object database、`.git` 元数据、remote refs 和本机文件权限；
- secret store、数据库、端口、依赖缓存以及其他宿主服务资源。

因此任务必须自行分配不冲突的端口、数据库 schema、缓存目录和服务进程，并且
不要把 credentials 写进 manifest、lock、argv、日志或测试输出。可选的
`.worktreeinclude` 只允许列出已被 Git 忽略的 `.env` / `.env.*` 文件；harness
会把它们复制到新 worktree，但只在状态中记录复制数量，绝不记录文件内容或
secret 值。`.worktreeinclude` 本身也被忽略。

根 checkout 永远 clean/read-only。根目录不是任务 worktree，任何把根目录作为
`--worktree` 的 claim 都会失败。初始化、依赖安装、构建和测试都在执行线程的
worktree 内完成；不要为了方便在根 checkout 运行会写入依赖、runtime 或生成物
的命令。

## Stacked PR 与 Merge Queue

Stacked PR 只表达任务之间的依赖顺序：每个 PR 仍然独立通过 required checks、
review 和签名要求。Merge Queue 只做组合验证，不能成为跳过审查、伪造批准或
绕过 branch protection 的通道。执行线程把完整证据交回主线程，主线程在里程碑
处汇总风险并安排下一步；未到里程碑时不以频繁人工打断替代 harness 检查。

CI 中 `make governance-check` 只执行确定性的本地 policy、fixture 和 Git 检查，
不调用 GitHub 写接口、不改变生产部署。docs-only 变更不需要部署；相关工作流
的路径过滤继续保持 no-op 语义。

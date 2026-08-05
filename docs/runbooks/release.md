# 发布与回滚

1. 确认 `main` 所有必需检查成功，Release Please 生成版本 PR。
2. Squash 合并版本 PR，确认 `vX.Y.Z`、CHANGELOG、SBOM 和 `release-evidence.json`。
3. Landing 通过 frozen install、lint、typecheck、build 和 smoke 后部署同一 `out` artifact。
4. 发现回归时停止后续发布，按变更类型回滚到上一个已验证 tag；不要重写或强推 tag。

Release Please 必须使用仓库级 Actions Secret `PIWORK_RELEASE_TOKEN`，且凭据必须在每次
运行时仍然有效。推荐使用只授予本仓库的 fine-grained PAT；如果使用 GitHub App，必须在
工作流运行时生成 installation token，不能把短期 token 手工保存后等它过期。仅授予本仓库
的 Contents、Pull requests、Issues 写权限，以及 Checks、Commit statuses 和 Dependency
graph 读权限，不授予组织管理、Actions 写入或其他仓库权限。不能回退到默认 `GITHUB_TOKEN`；
后者创建的 Release PR 不会触发后续必需的 PR 工作流。该 Secret 不得写入 `.env`、仓库文件、
日志或命令参数，且由 Leader 按轮换周期更新。

管理员配置（命令会从标准输入读取 Secret，不会回显值）：

```bash
gh secret set PIWORK_RELEASE_TOKEN --repo agentbridges-ai/pi-work
gh secret list --repo agentbridges-ai/pi-work | rg '^PIWORK_RELEASE_TOKEN\b'
```

`make github-governance-check` 会只读核对 Secret 名称是否存在；它不会也不能读取
Secret 值。发布工作流会先用无输出的仓库 API 请求验证凭据和仓库访问权，再调用 Release
Please；缺失、过期、撤销或权限不足时会在动作前失败并给出配置提示。

发布问题必须记录 commit、manifest digest、检查链接、受影响用户和后续修复 Issue。

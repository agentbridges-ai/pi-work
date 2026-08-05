# 发布与回滚

1. 确认 `main` 所有必需检查成功，Release Please 生成版本 PR。
2. Squash 合并版本 PR，确认 `vX.Y.Z`、CHANGELOG、SBOM 和 `release-evidence.json`。
3. Landing 通过 frozen install、lint、typecheck、build 和 smoke 后部署同一 `out` artifact。
4. 发现回归时停止后续发布，按变更类型回滚到上一个已验证 tag；不要重写或强推 tag。

Release Please 必须使用仓库级 Actions Secret `PIWORK_RELEASE_TOKEN`。优先使用只安装到
`agentbridges-ai/pi-work` 的 GitHub App installation token；若使用 fine-grained PAT，
仅授予本仓库的 Contents、Pull requests、Issues 写权限，以及 Checks、Commit statuses
和 Dependency graph 读权限，不授予组织管理、Actions 写入或其他仓库权限。不能回退到默认
`GITHUB_TOKEN`；后者创建的 Release PR 不会触发后续必需的 PR 工作流。该 Secret 不得写入
`.env`、仓库文件、日志或命令参数，且由 Leader 按轮换周期更新。

管理员配置（命令会从标准输入读取 Secret，不会回显值）：

```bash
gh secret set PIWORK_RELEASE_TOKEN --repo agentbridges-ai/pi-work
gh secret list --repo agentbridges-ai/pi-work | rg '^PIWORK_RELEASE_TOKEN\b'
```

`make github-governance-check` 会只读核对 Secret 名称是否存在；它不会也不能读取
Secret 值。缺失时发布工作流会在调用 Release Please 前立即失败，并给出同一个配置提示。

发布问题必须记录 commit、manifest digest、检查链接、受影响用户和后续修复 Issue。

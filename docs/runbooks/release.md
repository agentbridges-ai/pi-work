# 发布与回滚

1. 确认 `main` 所有必需检查成功，Release Please 生成版本 PR。
2. Squash 合并版本 PR，确认 `vX.Y.Z`、CHANGELOG、SBOM 和 `release-evidence.json`。
3. Landing 通过 frozen install、lint、typecheck、build 和 smoke 后部署同一 `out` artifact。
4. 发现回归时停止后续发布，按变更类型回滚到上一个已验证 tag；不要重写或强推 tag。

Release Please 必须使用组织管理员维护的 `PIWORK_RELEASE_TOKEN`（GitHub App
或具备仓库内容与 PR 写权限的 PAT），不能回退到默认 `GITHUB_TOKEN`；后者创建的
Release PR 不会触发后续必需的 PR 工作流。该 Secret 缺失时发布工作流应直接失败，
由 Leader 完成配置后再重试。

发布问题必须记录 commit、manifest digest、检查链接、受影响用户和后续修复 Issue。

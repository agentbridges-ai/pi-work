# 贡献指南

Piwork 由 `@Misakago` 作为 Leader/Owner，配合约五人的 Core Team 维护，并接受社区 Fork/PR 贡献。产品不把 Git、Worktree 或 Pull Request 当作用户功能；本文件只描述仓库协作流程。

## 开始贡献

1. 从 `origin/main` 创建分支，分支名使用 `misakago/<简短描述>`。
2. 小改动直接提交 PR；影响认证、租户隔离、凭据、Pi RPC/SRT、User Space、迁移、协议、CI 或发布的改动，先创建 RFC 或在 PR 中链接既有 RFC。
3. PR 标题使用 `type(scope?): 中文摘要`。允许的 type 为 `feat`、`fix`、`perf`、`refactor`、`docs`、`test`、`build`、`ci`、`chore`、`revert`。
4. 所有 PR 使用 Squash Merge；提交必须通过现有签名和 CI 门禁。不要把密钥、`.env`、数据目录、构建产物或其他仓库内容提交进来。
5. PR 描述必须说明动机、改动、风险等级、测试结果、迁移/回滚影响以及文档、i18n 和 a11y 影响。

## 评审与发布

- 普通改动需要一名最新提交后的 Core Team 非作者批准。
- 高风险改动需要两名 Core Team 非作者批准，并需要 `@Misakago` 作为作者或批准者参与。
- 社区贡献者默认通过 Fork 提交；持续贡献、能处理安全边界并参与评审后，由 Owner 邀请加入 Core Team。
- `main` 保持可发布；Release Please 负责 SemVer 标签和 GitHub Release，Piwork 不发布 npm 包。Landing Page 在 `main` 通过门禁后连续部署。

## 本地检查

```bash
make install
make check
make test
make governance-check
make security-check
make landing-check
```

产品不接受通过绕过检查来“修绿”的提交。若确有临时例外，必须登记在 `.governance/exceptions.json`，包含 Owner、跟踪 Issue 和到期日。

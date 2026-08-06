# Changelog

本文件由 Release Please 维护。版本使用 SemVer，标签格式为 `vX.Y.Z`；每个发布从已通过主分支门禁的 Squash commit 生成。

## [0.96.0](https://github.com/agentbridges-ai/pi-work/compare/v0.95.0...v0.96.0) (2026-08-06)


### Features

* add local Cloudflare tracing workflow ([#51](https://github.com/agentbridges-ai/pi-work/issues/51)) ([5f1666f](https://github.com/agentbridges-ai/pi-work/commit/5f1666f4e0accaa6a905234c097c46f159de86d3))
* **governance:** add isolated worktree orchestration harness ([#54](https://github.com/agentbridges-ai/pi-work/issues/54)) ([f1a4079](https://github.com/agentbridges-ai/pi-work/commit/f1a407956f3368026f47206ab0284cd6053f7666))
* integrate Piwork Apps and Compose Runtime isolation ([4d9e1bb](https://github.com/agentbridges-ai/pi-work/commit/4d9e1bb0fa0b976bae65b470fd1782bc228910a6))
* 建立 Piwork 设计系统 ([41782ac](https://github.com/agentbridges-ai/pi-work/commit/41782ac07b4607b4d444d9a11ae8147b3f109ef0))
* 建立 Piwork 设计系统 ([9fd2313](https://github.com/agentbridges-ai/pi-work/commit/9fd231386c7dc7f97537869a2dfab86619a96300))


### Bug Fixes

* align CI baseline integration ancestry ([15a5b23](https://github.com/agentbridges-ai/pi-work/commit/15a5b23c974237b16aa5435e94c71bc40aa58437))
* align governance apply with GitHub ruleset API ([6ff23dc](https://github.com/agentbridges-ai/pi-work/commit/6ff23dc68b5d5edebcff55d3aca7d168e8feb0a1))
* align landing with evidence-first design principles ([1e2bcdc](https://github.com/agentbridges-ai/pi-work/commit/1e2bcdc0e5f7c1aeab797cc9748efea0a23ddd02))
* align OnlyOffice pin with production runtime ([b51b486](https://github.com/agentbridges-ai/pi-work/commit/b51b486c9d40bdd460ac22f846a50db331d79593))
* align release lockfile digest ([1a35826](https://github.com/agentbridges-ai/pi-work/commit/1a35826169ecad5548aee4ca96e1783a72fbbdaa))
* **ci:** harden Dependabot and CodeQL verification ([#60](https://github.com/agentbridges-ai/pi-work/issues/60)) ([2ea0b90](https://github.com/agentbridges-ai/pi-work/commit/2ea0b90ca7a878d60731d8ce3fa4fc59377440af))
* close Piwork release validation gaps ([ae1aaf6](https://github.com/agentbridges-ai/pi-work/commit/ae1aaf6dc70c44011fce197778aa8f990d13df44))
* detect targets in multi-command workflows ([7e7f6be](https://github.com/agentbridges-ai/pi-work/commit/7e7f6beaaa69fceff00d1711248f9d109a89a8c3))
* expose hoisted workspace dependencies ([ca71bd4](https://github.com/agentbridges-ai/pi-work/commit/ca71bd4d4d1fe7cd4a4e8487779c108c6daabab1))
* fail fast on invalid release credentials ([#44](https://github.com/agentbridges-ai/pi-work/issues/44)) ([00c8389](https://github.com/agentbridges-ai/pi-work/commit/00c83897011dfcb50bf01ce8d77fdd6586a2177c))
* **governance:** count Leader author audit ([#61](https://github.com/agentbridges-ai/pi-work/issues/61)) ([c455afd](https://github.com/agentbridges-ai/pi-work/commit/c455afdd62e24d05fd9759deddce4ae2da1904b8))
* install required platform packages in CI ([f03af1f](https://github.com/agentbridges-ai/pi-work/commit/f03af1f45bf87afe2bcdceea9f26be680c38b2ac))
* make governance audit author-aware ([#41](https://github.com/agentbridges-ai/pi-work/issues/41)) ([a6d7d8b](https://github.com/agentbridges-ai/pi-work/commit/a6d7d8bae01e2b523193f7079afc8a4cc46b9aa5))
* pin the published OnlyOffice tarball ([ea55620](https://github.com/agentbridges-ai/pi-work/commit/ea55620ec81d5626660c6c57b47ab685779d48fe))
* pin verified OnlyOffice 0.4.1 release ([acd26a4](https://github.com/agentbridges-ai/pi-work/commit/acd26a473e80f2de240646600fa89820e75b30b1))
* pin verified OnlyOffice 0.4.7 release ([893d4d8](https://github.com/agentbridges-ai/pi-work/commit/893d4d8088db8fd4d733bc9b6a9210f661428192))
* preserve community review baseline ([#43](https://github.com/agentbridges-ai/pi-work/issues/43)) ([65f1351](https://github.com/agentbridges-ai/pi-work/commit/65f13514ab4fec237a4e67a45a0270483202a846))
* preserve frozen install command contract ([9d349bd](https://github.com/agentbridges-ai/pi-work/commit/9d349bd36d2c9caad2813306afc5570441e476fe))
* publish governance status through REST ([993225e](https://github.com/agentbridges-ai/pi-work/commit/993225e76f89ee236e3ada0b0b2c2e68d6ac7f96))
* scope OnlyOffice integration-base gate ([66e4981](https://github.com/agentbridges-ai/pi-work/commit/66e49813d331a39e8c00ff345ccfe92a8ad6825b))
* use one dependency tree in CI ([6b84bb2](https://github.com/agentbridges-ai/pi-work/commit/6b84bb264325ff2b7fcbd8f12246b06d12dd5011))
* 保证必需 SRT 检查覆盖所有 PR ([ab2de17](https://github.com/agentbridges-ai/pi-work/commit/ab2de17e5ce69e5d4cca93ba30ce1a7e32ba7835))
* 修复 Landing workspace 部署安装 ([3272aa3](https://github.com/agentbridges-ai/pi-work/commit/3272aa3cf7c262fd233c13f36af2e53a25d46fdd))
* 修复 Landing workspace 部署安装 ([0c2604a](https://github.com/agentbridges-ai/pi-work/commit/0c2604a1452f63e3ab9e1610714c604af6c66ad3))
* 修正 Landing 导航与部署触发 ([b2a60a4](https://github.com/agentbridges-ai/pi-work/commit/b2a60a47ac33bc1e4f71914de1d402b1120c90fe))
* 修正 Landing 文字色语义 ([4809acf](https://github.com/agentbridges-ai/pi-work/commit/4809acf9fd4169abc883f2a84d3af66be2f04c62))
* 修正共享组件 JSX 转换 ([969f1d9](https://github.com/agentbridges-ai/pi-work/commit/969f1d922bb04687e7ded1326ab5f4c7fce663d6))
* 同步 OnlyOffice 锁文件摘要 ([d3b99bc](https://github.com/agentbridges-ai/pi-work/commit/d3b99bcc17f00487abbb68a6b1a2a4498be89de0))
* 同步 OnlyOffice 集成基线 ([251e723](https://github.com/agentbridges-ai/pi-work/commit/251e7232fa81abbe315ed4ebd0ac0f93a149f420))
* 同步根工作区 Bun 锁文件 ([948815c](https://github.com/agentbridges-ai/pi-work/commit/948815c03f73734f4cc8bd41d7c01e4f81dd210e))
* 同步部署补丁集成基线 ([1be8b8a](https://github.com/agentbridges-ai/pi-work/commit/1be8b8a46da90c95c2954422b34ae4d7213c9196))
* 对齐工作区依赖安装路径 ([39d7bc6](https://github.com/agentbridges-ai/pi-work/commit/39d7bc62524f302d6c41d8abbec7a78e7338d305))
* 统一 Pages 工作区安装参数 ([b559a4d](https://github.com/agentbridges-ai/pi-work/commit/b559a4d55951a4c995574903fb8b42212ea034ad))
* 补齐 Landing 工作区部署触发 ([86d13af](https://github.com/agentbridges-ai/pi-work/commit/86d13af9f3f258627df995943d752189c9a95406))
* 补齐共享 UI 的 React 类型依赖 ([66d78a1](https://github.com/agentbridges-ai/pi-work/commit/66d78a1002919a7267247f9528e84f596a9c0118))

## [Unreleased]

- 建立 Piwork 工程治理基线、社区贡献流程和可审计发布门禁。

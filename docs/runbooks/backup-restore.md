# 备份与恢复

使用 `make backup` 创建备份，使用 `make backup-verify BACKUP=...` 验证 checksum 和路径安全。恢复演练必须在临时数据根和临时 Postgres 中完成，确认 Better Auth 表、Pi runtime marker、用户 profile 和 Session 文件可读取，再删除临时资源。生产恢复前由 Owner 记录实际 RTO/RPO 和回滚点；当前 local-first 版本不宣称统一 SLA。

# 合约、数据与兼容性

新建或修改 HTTP/WS 合约必须复用 `web/shared` 类型、统一错误结构和 requestId；复杂 DTO 的 Schema-first 转换进入 RFC，不在本基线中一次性重写既有 API。

数据库当前仍由仓库已有 SQL 管理。本次冻结新增迁移的随意命名，创建不可变有序迁移账本 RFC；迁移执行器和 expand/contract 流程在专项改造完成前不得被隐式引入。

兼容性以 release manifest 为机器权威，文档不得独立维护与 manifest 冲突的版本。弃用必须在 CHANGELOG、迁移说明和至少一个版本周期内的兼容矩阵中出现。

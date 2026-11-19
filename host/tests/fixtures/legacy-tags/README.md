# 标签迁包前的测试契约

从提交 `13069ea` 的 `src/plugins/tags/` 冻结核心、数据块和命令，仅调整导入路径。用于生成真实旧库及原业务回归，生产装配不导入此目录；不要跟随新包改动更新旧定义。实际外部包加载、交接及兼容校验见 `tests/integration/packaged-tags-table.test.ts`。

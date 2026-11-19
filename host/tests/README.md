# 验证目录

- `core/`：数据、查询、历史、调度、性能基准。
- `plugins/`：具体插件的业务行为。
- `integration/`：宿主装配、公共 API、插件包、MCP、迁移和跨模块协作。
- `electron/`：真实应用操作和截图流程，入口由 `src/main/capture.ts` 接入。
- `fixtures/`：样本、冻结旧定义和演示数据生成；不要用当前插件覆盖旧兼容性样本。
- `helpers/`：临时仓库、旧装配与共用辅助函数。

`npm test` 发现 `tests/**/*.test.ts`，排除 `external-suites.json` 中需独立插件源码的专项；这些通过 `npm run test:plugins` 显式运行。`npm run bench` 单独启用基准。真实应用验证必须显式设置 `CAPTURE_DIR`，临时库使用 `LIBRARY_PATH`，用户配置使用独立 `RM_USER_DATA`。开发者可把截图和日志放在 Git 忽略的 `artifacts/checks/`，不要混入实际用户库。

完整流程、准备条件和覆盖范围见[开发与验证](../docs/development/开发与验证.md)。

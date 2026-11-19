# 插件扩展插件：独立包示例

- `provider/`：定义 `demo-extension-provider.actions` v1，提供 A／B 两个页面。
- `contributor/`：可选依赖提供方，贡献按钮、异步动作和组件。
- `contract/`：共享的纯类型包，两个工程分别声明 `file:../contract` 开发依赖。它不是第三个插件。

源码需要一起复制这三个目录，或将契约包单独发布后修改依赖。类型导入用 `import type`，不把提供方实现打进贡献方。运行时依靠稳定点 ID 和版本协作，不靠共享模块对象身份。

在两个工程各执行一次：

```sh
npm install --offline --ignore-scripts --legacy-peer-deps --no-audit --no-fund
```

在宿主根目录分别打包（输出目录先建立）：

```sh
npm run plugin:pack -- examples/extensions/provider /tmp/provider.rmplugin
npm run plugin:pack -- examples/extensions/contributor /tmp/contributor.rmplugin
```

在临时仓库批量安装两个包，勾选并统一应用；Cmd/Ctrl+P 搜索“打开扩展示例 A／B”。两个包的 `ui-extension-points-v1` 要求支持本能力的宿主。

提供方会显示另一个包提供的计数按钮与组件。切换 A／B，延迟动作仍回到原页面；关闭原页则忽略其计数更新。改变“错误演示”可测试同步动作、异步动作和组件渲染失败。渲染错误占位到边界重挂才恢复，其他按钮仍可用。

贡献方故意包含未知契约版本和缺失字段两项，用来演示「设置 → 当前仓库 → 功能与插件 → 插件协作问题」。这不是正式插件出错的模板；发布实际插件时应移除无效条目。停用提供方，贡献方的“检查贡献方仍启用”命令仍可执行；重新启用后协作恢复。

完整隔离验证：先 `npm run build`，再 `node tests/electron/sidebar-layout-check.mjs --extensions`；启动器会在临时目录安装依赖和打包，不修改示例目录。见[接入规范](../../docs/plugins/插件自定义UI扩展点.md)。

# 活页Huoye 宿主

以稳定身份与可组合数据块为基础的资源中心。仓库管理素材和附加内容，文件空间管理原件及版本，插件提供业务和呈现。

Node.js 24+；首次 `npm ci`，开发 `npm run dev`，检查 `npm run typecheck`，构建 `npm run build`，预览 `npm start`。开发和预览默认使用 `.local/user-data`。宿主可独立构建；外部插件源码位置可配置，普通构建使用已提交的发行套件，首次启动即可按两套方案建库。

- [源码工作区说明](../README.md)
- [快速入门](docs/user/快速入门.md)
- [设计理念](docs/architecture/设计理念.md)与[当前架构](docs/architecture/设计文档.md)
- [开发与验证](docs/development/开发与验证.md)、[插件开发](docs/plugins/插件开发指南.md)
- [公共 API 总览](docs/plugins/公共API总览.md)、[文档导航](docs/README.md)

项目与自有插件采用 [Apache-2.0](../LICENSE)。第三方组件各自保留原许可，详见 [第三方说明](../THIRD-PARTY-NOTICES.md)。Windows 发行暂缓；平台验证以交付记录为准。

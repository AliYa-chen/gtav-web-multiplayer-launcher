# Release categories

[English](#english) | [简体中文](#简体中文)

## English

The [release page](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher/releases) separates the browser/desktop launcher from the Java world server. Each component has its own version and changelog.

| Category | Tag pattern | Contents |
| --- | --- | --- |
| Launcher | `launcher-vX.Y.Z` | Browser client, engine adaptation description, desktop launcher source, and launcher-specific changes. Binary assets, when supplied separately, identify their actual platform and version. |
| Server | `server-vX.Y.Z` | Java shared-world server and server-specific changes. An existing verified JAR may be attached with its own SHA-256. |

Releases use English notes first and Simplified Chinese second. A source-only release contains GitHub's automatically generated source ZIP/TAR, not newly compiled applications. A tag/version does not turn an older binary into a new build. Existing installer versions remain explicit in their filenames and release notes.

Current source delivery consists of committing code and documentation and publishing the appropriate component release. Desktop/JAR builds and website configuration updates are separate operations; creating a Release does not rebuild a client, restart a server, or update `remote-config/index.php`.

The 0.2.16 launcher source contains the synchronized explosive-rendering fix. The previously compiled Windows x64 and macOS arm64 packages are version 0.2.15. The server remains at 0.4.3; it does not need a new version for this client-side change.

Original game engines, resources and derived world geometry are not release source assets. The project's [MIT License](../LICENSE) and [NOTICE](../NOTICE.md) define the source and third-party scope. Build and feature-maintenance instructions remain in [multiplayer development](multiplayer-development.md).

## 简体中文

[发布页面](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher/releases)将网页/桌面启动器和 Java 世界服务端分开，两者独立记录版本和更新说明。

| 分类 | 标签格式 | 内容 |
| --- | --- | --- |
| 启动器 | `launcher-vX.Y.Z` | 网页客户端、引擎适配描述、桌面启动器源码及对应更新。另行提供二进制时，明确其真实平台和版本。 |
| 服务端 | `server-vX.Y.Z` | Java 共同世界服务端及对应更新。可附已有且已核验的 JAR，并提供独立 SHA-256。 |

说明统一英文在前、简体中文在后。源码发布包含 GitHub 自动生成的源码 ZIP/TAR，不代表新编译的应用。旧二进制不能因为标签或版本说明改变就当成新版，安装包文件名和说明始终保留实际版本。

当前源码交付流程是修改代码/文档、提交推送、发布对应组件 Release。桌面/JAR 构建和网站配置更新独立处理；创建 Release 不会自动重建客户端、重启服务端或更新 `remote-config/index.php`。

启动器 0.2.16 源码包含共享爆炸效果渲染修复；此前已编译的 Windows x64 和 macOS arm64 安装包版本为 0.2.15。服务端仍为 0.4.3，本次客户端修复不需要改变服务端版本。

原游戏引擎、资源和派生世界几何不作为 Release 源码附件。项目 [MIT 许可](../LICENSE)及[第三方声明](../NOTICE.zh-CN.md)说明授权范围，构建与功能维护方法见[多人开发指南](multiplayer-development.zh-CN.md)。

# GTAV 网页版多人启动器

[English](README.md) | [简体中文](README.zh-CN.md)

面向已支持 GTAV 浏览器引擎的桌面启动器、网页客户端同步桥和 Java 实验性共同世界服务端。启动器只读玩家自己的资源，游戏在支持 WebGPU 的浏览器中运行。

**[官方网站](https://gtav.2t.hk/) · [GitHub 仓库](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher)**

本仓库保存项目源码与文档，**不提供游戏本体、原浏览器引擎、RPF、地图、纹理、字体或其他专有游戏资源**。普通 PC 版 GTA V 安装目录不能直接替代本项目支持的浏览器引擎资源结构。

## 当前范围

- Windows x64 和 macOS Apple Silicon 的 Tauri 2 启动器；游戏由默认浏览器渲染。
- 故事、自由沙盒和公共战局入口；支持 English、简体中文及跟随系统。
- 只读资源识别与版本校验、隔离的运行引擎/字体缓存，以及本机或局域网 HTTPS 资源服务。
- 公共线路、名称、公告和下载信息统一来自[配置接口](https://oss.2t.hk/gtav/)，客户端不内置公网服务器地址。
- 独立 Java 17+ 服务端统一保存玩家与实体身份、座位、所有权租约、战斗判定、重生、人口、天气及执法规则；获授权的客户端引擎执行指定的原生移动与车辆模拟。

**客户端 0.2.15、服务端 0.4.3-world-experimental。** 本轮包含乘客座位纠正与所有权修复。macOS 构建已在本机核验，Windows 构建由 GitHub Actions 生成并通过核验；服务端 0.4.3 已部署到中美两地的正式与实验战局，共四条线路。客户端安装包与配置仍需手动上传下载站。详见 [0.2.15 构建与部署记录](docs/0.2.15多人同乘与公开源码.md)；源码和构建版本号不能单独证明下载站当前已经更新。

多人功能仍为实验状态。静态碰撞和行人导航覆盖出生区附近约 **600×600 米**，尚未覆盖整张地图。服务端没有完整 RAGE 物理运行时，全部单机脚本、工具、任务和载具武器也尚未迁移。本项目使用自有协议，不兼容原 GTA Online 或 FiveM。协议测试不能证明完整游戏同步已完成，`game_sync` 和 `native_clone_transport` 仍为 false。

## 多人如何实现

原始游戏 WASM 由玩家提供。本项目生成隔离的适配运行副本，接入自己编写的 JavaScript 同步桥，由 Java 服务端裁决共同世界状态与规则。Python 脚本用于审计和生成适配，成品客户端使用 Rust 重现适配，不依赖 Python。普通功能主要修改 JS 和 Java；新增引擎接口能力时才需要进一步分析原生接口。

实现与扩展流程见[多人架构、构建和维护](docs/multiplayer-development.zh-CN.md)，其他网站接入见[网站集成指南](docs/website-integration.zh-CN.md)。

## 实机截图

以下截图记录此前的实际游戏演示。游戏画面继续适用其权利人的条款，详见 [NOTICE.zh-CN.md](NOTICE.zh-CN.md)。

![两个浏览器客户端展示洛圣都改车店前的车辆与附近玩家](docs/images/multiplayer-vehicles.jpg)

*两个浏览器客户端中的车辆与附近玩家。*

![夜间游戏画面中出现亮着警灯的警车](docs/images/police-response.jpg)

*此前演示中的警察场景与通缉星级。*

<details>
<summary>更多截图</summary>

![两个浏览器客户端展示玩家彼此瞄准的战斗场景](docs/images/player-combat.jpg)

*玩家对战的双客户端视角。*

![游戏地图显示两名玩家的独立标记](docs/images/map-player-markers.jpg)

*游戏地图中的玩家标记。*

![两个客户端展示交火时的命中反馈](docs/images/combat-hit.jpg)

*玩家交火中的命中反馈。*

![一个客户端显示倒地玩家，另一个客户端显示死亡画面](docs/images/combat-death.jpg)

*同一战斗场景与玩家死亡画面。*

</details>

## 快速开始

### 使用桌面客户端

1. 从[官网](https://gtav.2t.hk/)查看可用客户端与服务器状态。
2. 打开 Windows EXE 或 macOS App，选择自己准备的、版本受支持的浏览器游戏资源目录。
3. 选择故事、沙盒或公共战局；公共战局需选择可用线路并填写昵称与角色预设。
4. 启动游戏，使用支持 WebGPU、WebAssembly 线程及共享内存的新版 Chrome 或 Edge。

成品启动器无需安装 Python、Java、Node.js 或 Rust。Windows 需要 WebView2；当前 macOS 包采用开发/ad hoc 签名，尚未公证。资源识别、局域网共享、证书信任和平台要求见[桌面启动器说明](desktop/README.md)。

### 从源码运行

安装 Python 3.11+，在仓库之外准备受支持的资源根目录：

```text
/path/to/browser-game/
├── b/8b0b5899ed/game.wasm
├── b/8b0b5899ed/game.js
├── b/8b0b5899ed/io_worker.js
├── b/8b0b5899ed/wgpu_worker.js
└── data/manifest.json          # 以及配套游戏数据
```

在仓库根目录执行：

```sh
python3 -B tools/build_multiplayer_client.py --game-dir "/path/to/browser-game"
python3 -B serve_local.py --game-dir "/path/to/browser-game" --host 127.0.0.1 --open
```

第一条命令在启动器自己的 `client/runtime/` 生成离线与在线运行副本，校验原引擎 SHA-256，不兼容版本会明确失败；不会修改游戏资源目录。离线副本与原始输入字节一致。受支持哈希和外部运行目录配置见[资源隔离说明](docs/启动器资源隔离.md)。

游戏运行期间保持终端开启，按 `Ctrl+C` 停止。不要直接通过 `file://` 打开 HTML，本地服务需要提供跨域隔离响应头和范围读取。Windows 可使用已安装的 Python 3.11+（`python` 或 `py -3`），也可参阅启动脚本；源码仓库不附 Python 运行环境。

### 构建与运行本地共同世界服务端

安装 JDK 17+ 和 Python 3.11+。服务端不依赖 Maven、数据库、第三方 Java 库或游戏引擎运行时：

```sh
python3 -B tools/build_multiplayer_server.py
java -jar server/multiplayer-server.jar --host 127.0.0.1 --port 8787
```

访问 `http://127.0.0.1:8787/health` 检查就绪状态。可另行安装 `server/world-data/` 提供局部碰撞和导航数据；源码仓库不提供游戏派生几何，健康接口报告实际加载能力。远程部署、TLS、进程管理和回滚见[服务端说明](server/README.md)与[部署说明](server/deploy/README.md)。

准备好客户端运行副本后，也可以一条命令启动本地服务端与两个开发客户端：

```sh
python3 -B serve_local.py --game-dir "/path/to/browser-game" --host 127.0.0.1 \
  --start-room-server --room-server 127.0.0.1:8787 --instances 2 --open
```

使用 `--start-room-server` 前停止另外启动的同端口服务。开发测试通过参数显式指定地址，普通玩家使用接口提供的公网线路。

## 构建桌面客户端

安装 Node.js 22.12+（CI 使用 Node 24）、稳定版 Rust 和对应平台的 [Tauri 构建前提](https://v2.tauri.app/start/prerequisites/)：macOS 的 Xcode Command Line Tools，或 Windows 的 MSVC 构建工具与 WebView2。

```sh
cd desktop
npm ci
npm run desktop:dev
```

在目标操作系统构建：

```sh
# macOS Apple Silicon App
npm run desktop:build:mac

# Windows x64 便携 EXE，在 Windows 终端执行
npm run tauri -- build --no-bundle
```

产物在 `desktop/src-tauri/target/release/`，macOS App 位于其 `bundle/macos/`。桌面产物文件名沿用 `GTA5Data` 前缀。两个 GitHub Actions 工作流均需手动触发，只提供构建 Artifact，不自动发布 GitHub Release。桌面源码构建不需要或嵌入游戏资源。

## 仓库目录与文件作用

| 路径 | 作用 |
| --- | --- |
| `client/` | 浏览器入口、加载工作线程、语言文字和项目自有的运行时衔接代码。 |
| `client/index.html` | 启动器提供的网页模式选择和游戏加载界面。 |
| `client/loader.js` | 加载所选隔离运行引擎并连接引擎工作线程。 |
| `client/multiplayer/` | 公共战局通信、玩家/世界快照、原生实体桥和动作/效果同步。 |
| `desktop/` | Tauri 桌面应用及 npm/Cargo 构建配置、依赖锁文件。 |
| `desktop/src/` | 启动器界面、多语言词典、线路健康检查与设置交互。 |
| `desktop/src-tauri/` | Rust 资源识别、原引擎校验、缓存准备、本机/局域网资源服务与原生命令。 |
| `desktop/scripts/` | 平台构建辅助脚本，包括本机 macOS App 构建。 |
| `server/src/main/java/` | 独立 Java 共同世界服务端：协议、实体注册、战斗、AI、所有权和地图查询。 |
| `server/deploy/` | 远程部署说明、服务配置、TLS/反向代理设置和运维脚本。 |
| `remote-config/index.php` | 可部署的 JSON 配置接口，管理公告、线路、客户端版本、下载链接与哈希；状态网站独立维护。 |
| `tools/` | 构建/打包、只读引擎分析、隔离适配生成与可选的世界数据提取工具。 |
| `tools/readonly_game_outputs.py` | 共用输出保护与原子发布工具，防止生成物覆盖玩家资源。 |
| `docs/` | 设计、协议、审计、功能边界和历史构建/部署证据。 |
| `.github/workflows/` | 手动触发的 macOS 与 Windows 客户端构建流程。 |
| `serve_local.py` | 可选的 Python 本地 HTTP/资源服务，以及显式启动本地多人开发服务。 |
| `Launch-Local.cmd` / `Start-Local.ps1` | Windows 的 Python 本地服务启动封装，需有可用 Python 运行环境。 |
| `AGENTS.md` | 开发硬约束，包含玩家游戏资源必须只读的边界。 |
| `.gitignore` | 排除游戏资源、运行缓存、二进制、本地验证文件和其他生成/本机材料。 |
| `README.md` / `README.zh-CN.md` | 默认英文项目入口说明与简体中文版。 |
| `LICENSE` / `NOTICE.md` / `NOTICE.zh-CN.md` | MIT 许可、版权与项目链接、双语第三方/游戏资源授权范围声明。 |

`gta5data/` 等玩家资源、生成的 `client/runtime/`、提取的 `server/world-data/` 和桌面构建/下载产物都属于本机材料，不随源码分发。本地验证文件也不提交。

## 资源和分发边界

玩家资源必须**只读**，包括外部资源目录、清单、原始 WASM/JS、归档、地图和字体。功能应实现于启动器、同步桥、启动器隔离缓存或服务端；禁止将适配引擎写回来源目录、绕过版本校验或依赖历史游戏资源修改。服务器派生几何单独写入 `server/world-data/`，不得提交。输出保护拒绝游戏目录、符号链接逃逸和输入文件别名，使用独立临时文件与原子替换发布。

启动器按既有局域网共享设计有意内置可随源码分发的 **LAN CA 私钥**。它可以被提取，不属于保密的生产环境身份。生产 TLS 证书/私钥文件与服务器登录凭据不在本仓库中。信任方式见[局域网 HTTPS 说明](desktop/README.md#局域网-https-资源共享)。

贡献前阅读 [AGENTS.md](AGENTS.md)，使用 `python3 -B tools/check_git_contents.py` 检查暂存区只包含源码。技术记录说明实现范围，以及已完成的静态检查和协议验证。

## 详细资料

建议先阅读[多人实现、构建与维护指南](docs/multiplayer-development.zh-CN.md)和[网站集成指南](docs/website-integration.zh-CN.md)。历史文档中的旧版本小节描述的是当时状态。

- [多人实现与功能维护](docs/multiplayer-development.zh-CN.md) · [集成到其他网站](docs/website-integration.zh-CN.md)
- [资源隔离](docs/启动器资源隔离.md) · [桌面使用与构建](desktop/README.md)
- [远程配置](docs/远程启动器配置.md) · [国际化](docs/启动器国际化.md)
- [统一世界设计](docs/统一世界服务端设计.md) · [共同环境协议](docs/统一世界环境协议.md)
- [武器目录与权威战斗](docs/武器目录与权威战斗.md) · [AI 与脚本迁移](docs/AI行为与事件迁移.md)
- [人口与步行 AI](docs/服务端人口与步行AI.md) · [碰撞与物理](docs/服务端碰撞与物理实现.md)
- [原生网络复制审计](docs/原生网络复制可行性审计.md) · [FiveM 参考与浏览器边界](docs/FiveM参考与浏览器实现边界.md)
- [加载流程](docs/加载流程与启动器入口.md) · [0.2.15 发布记录](docs/0.2.15多人同乘与公开源码.md) · [0.2.14 发布记录](docs/0.2.14中美线路与构建记录.md)

## 许可

项目自有原创代码和文档采用标准 **[MIT License](LICENSE)**，允许使用、修改、合并、发布、分发、再许可和出售副本，包括商业使用。所有副本或实质性部分须保留版权声明和许可声明。版权声明包含[官网](https://gtav.2t.hk/)与[仓库](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher)链接。MIT 不附加界面署名或公开修改源码的要求。

软件按**原样提供，不作任何担保**。完整免责声明和责任限制见英文 LICENSE；版权及第三方范围说明见 [NOTICE.md](NOTICE.md) 与 [NOTICE.zh-CN.md](NOTICE.zh-CN.md)。

本许可不授予 GTA/GTAV 游戏内容、原引擎、游戏派生资源、商标或第三方材料的权利，这些材料继续适用其权利人的条款。本项目独立开发，不声称与 Rockstar Games、Take-Two Interactive 或原引擎作者存在隶属关系或获得其认可。

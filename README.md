# GTA 浏览器离线版

本仓库保存服务器、网页和多人同步桥源码。游戏资源目录统一命名为 `gta5data/`，
整个目录已被 Git 忽略，不随仓库上传。页面与工作线程源码在 `client/`，
本地服务器将它们映射到浏览器原有路径；更换资源目录名称不会改变页面 URL。

从仓库克隆后，可直接构建独立 Java 服务端；运行 GTA 客户端还需要自行准备同版本的
`gta5data/` 资源，仓库不提供游戏数据、WASM、字体、Python 便携运行环境或成品压缩包。

启动服务器后，使用支持 WebGPU 和该版本 WebAssembly 的浏览器打开游戏。
已在 Chrome 154 / macOS 上验证 GTA V 沙盒可以进入游戏，菜单繁体中文显示正常。
游戏引擎构建为 `8b0b5899ed`；资源快照采集于 2026-10-06。

## 启动游戏

### macOS / Linux

在本目录打开终端，运行：

```sh
python3 serve_local.py --open
```

需要 Python 3.11 或更新版本。`--open` 会打开默认浏览器；建议使用支持所需功能的 Chrome。

### Windows

双击 **Launch-Local.cmd**。项目自带 Windows x64 Python 运行环境，解压完整项目后即可使用。
也可以运行 **Start-Local.ps1**，它会优先使用项目自带的 Python。

保持服务器窗口开启，按 `Ctrl+C` 停止。

### 游戏入口与按键

- GTA V 沙盒：[进入游戏](http://localhost:8000/?mode=sandbox)
- 网站标称的 GTA VI 测试地图：[进入测试地图](http://localhost:8000/?mode=sandbox&map=env_test)
- 故事模式：[进入故事模式](http://localhost:8000/?mode=story)

在首页按 `空格` 选择沙盒，再按 `5` 或 `6` 选择地图；按 `回车` 选择故事模式。
进入游戏后点击画面捕获鼠标，按 `Esc` 释放鼠标。
不要直接通过 `file://` 打开 HTML 文件，游戏需要本地服务器提供跨域隔离响应头和范围读取。
端口被占用时，改用 `python3 serve_local.py --port 8001 --open`。

## 公共战局实验版

服务端只有一个常驻的 `PUBLIC` 公共战局。玩家填写服务器 IP 和昵称后自动加入，
不需要房间码、创建房间、准备或房主批准。地图固定 GTA V 沙盒。

独立 Java 服务端位于 `server/`，可以整目录复制到服务器；运行时只需 Java 17+ 和 JAR，
不需要游戏数据。部署方法见 [服务端说明](server/README.md)。

在另一个终端启动公共战局：

```sh
java -jar server/multiplayer-server.jar --host 0.0.0.0 --port 8787
```

客户端连接远程战局：

```sh
python3 serve_local.py --multiplayer --room-server 服务器IP:8787 --open
```

本机用一条命令启动 Java 战局与两个独立客户端：

```sh
python3 serve_local.py --start-room-server --instances 2 --open
```

如果已单独启动 Java 服务，则省略 `--start-room-server`：

```sh
python3 serve_local.py --instances 2 --multiplayer --room-server 127.0.0.1:8787 --open
```

两份大厅分别使用不同 localhost 端口，独立缓存、存档和引擎广播频道。
两边连接后各自点“进入在线战局”，并保持大厅标签页开启；它持有公共战局连接。
测试阶段所有玩家在固定坐标 `(711.5, -1088.1, 22.4)` 附近出生，按顺序错开两米防止重叠，
不再使用随机出生点或依赖其他玩家的坐标。进入后可自由移动，不会持续被拉回出生点。
在线加载显示“加入战局中”并保留一个旋转图标。在线入口清除模式和调试参数，
屏蔽 Shift+P、帧率及调试按键。

### 局域网查看

`serve_local.py` 默认监听 `0.0.0.0`，启动时打印本机和局域网访问地址。
`--room-server auto` 会根据网页访问 IP 选择同机的 8787 战局端口，
不会让其他电脑误连自己的 `127.0.0.1`。也可显式指定远程战局地址。

```sh
python3 serve_local.py --host 0.0.0.0 --port 8010 --instances 2 --start-room-server
```

其他设备可访问 `http://本机局域网IP:8010/multiplayer/`；大厅不需要加载游戏。
实际 GTA 引擎需要浏览器的安全上下文，普通局域网 HTTP 不支持所需的 WebGPU/共享内存。
玩家可以在自己电脑用 localhost 游戏客户端，或给局域网游戏页部署受信任的 HTTPS。
仅本机使用时改为 `--host 127.0.0.1`。

### 实现与限制

服务端已实现成员、聊天、角色状态和射击事件转发；客户端用游戏自身的角色命令
创建远端替身、插值更新位置和朝向，并播放射击任务。
已在真实游戏中验证坐标读取与测试角色创建，双客户端互见与移动正在复测。
**当前是实验版：伤害、击杀、死亡重生、步行动画与载具同步尚未完整实现。**
不能当作完整 GTA Online 或 FiveM 的替代品。

单机仍使用原始 `game.wasm`；公共战局使用独立 `game-multiplayer.wasm` 副本，
增加已核对的实体命令导出和有效脚本线程回调。原始游戏资源和 WASM 保留不变。
原线上模式的主要数据包传输在此构建中为空实现，不能只替换私服 IP 恢复原 GTA Online。
证据见 [原线上模式审计](docs/原线上模式审计.md) 与 [角色同步接口审计](docs/角色同步接口审计.md)。

重新构建与测试：

```sh
python3 tools/build_multiplayer_server.py
python3 tools/build_multiplayer_client.py
python3 -B tools/tests/test_multiplayer.py
```

服务器只需要 JAR；客户端的构建命令必须在已有完整游戏项目内执行。

## 目录说明

| 路径 | 用途 |
| --- | --- |
| `serve_local.py` | 本地服务器，仍可直接从根目录启动 |
| `Launch-Local.cmd` / `Start-Local.ps1` | Windows 启动脚本 |
| `client/index.html` | 实际使用的中文网页入口 |
| `client/multiplayer/` | 公共战局页面、共享快照桥和实体同步源码 |
| `client/loader.js` | 引擎加载工作线程源码，通过服务器映射到原 URL |
| `gta5data/b/8b0b5899ed/` | 引擎、工作线程、着色器及标题画面资源 |
| `gta5data/data/` | 游戏数据，本次整理没有改动 |
| `runtime/` | Windows x64 Python 运行环境 |
| `tools/` | 校验、打包、下载及分析工具；游戏启动不需要手动运行它们 |
| `server/` | 可脱离游戏资源单独部署的 Java 大厅 JAR、启动脚本及源码 |
| `docs/` | 中文说明与调查报告 |
| `docs/snapshot/` | 资源清单、哈希、历史证据及本地修复记录 |
| `archive/original/` | 原始网页、JS 和清单参考副本，校验工具仍会读取 |
| `archive/documents/` | 原始英文文档，供核对历史证据 |
| `archive/legacy/` | 旧打包辅助脚本，已退出日常使用流程 |
| `archive/cache/` | 从根目录移走的系统元数据和 Python 缓存 |
| `archive/packages/` | 打包工具的输出目录，首次打包时创建 |

`gta5data/`、`runtime/`、`archive/`、`docs/snapshot/` 和 JAR/ZIP 等生成文件都被 Git 忽略。
仓库只提交源码、中文说明与测试。`tools/mirror_site.py` 和 `tools/public_discovery.py`
运行时必须通过 `--origin` 或 `GTA5DATA_SOURCE_URL` 提供资源来源，源码不写死站点域名。
提交前可运行 `python3 tools/check_git_contents.py`，检查暂存区没有游戏资源或超过 5 MiB 的文件。

原来散落在根目录的参考文件已经归档。请保留 `archive/original/`，它是校验和维护工具的参考来源。
目录迁移记录见 [整理记录](docs/整理记录.md)。

## 中文化与启动修复

网页中的模式选择、加载状态、操作提示和错误提示已翻译为简体中文。
引擎函数名、错误堆栈、协议字段、资源路径及原始证据字面量保留原文，便于诊断。
游戏内菜单使用资源包自带的繁体中文；本快照没有完整的简体中文语言包。
原始英文网页和说明保存在归档目录。

之前卡在 76% 或 90% 的原因是 Scaleform 无法从相对路径打开字体库，小地图加载失败后触发 WASM 越界。
启动脚本现已在引擎运行前预载字体。中文浏览器自动使用已有的繁体中文资源，避免菜单出现 `missing` 或方框。
原始 WASM 引擎和归档资源没有改写。修复记录位于 `docs/snapshot/local-scaleform-fix.json`；
网页中文化的哈希单独记在 `docs/snapshot/local-overrides.json`，没有篡改原采集清单。

## 校验与诊断

校验当前文件、关键运行文件的哈希以及本地 HTTP 读取：

```sh
python3 tools/verify_snapshot.py
```

Windows 便携版：

```bat
runtime\python.exe tools\verify_snapshot.py
```

如果加载出错，打开[诊断页面](http://localhost:8000/?mode=sandbox&nocache=1&console=1&log=1)。
日志保存到 `docs/snapshot/browser-local.log`，只保留在本机。
也可用 `--log-file 路径` 指定日志文件；相应命令行帮助：

```sh
python3 serve_local.py --help
```

`memory access out of bounds` 本身不能证明内存不足，请结合崩溃前的引擎日志判断。

## 打包与维护

完整便携包会包含游戏数据，体积约 20 GB；按需运行：

```sh
python3 tools/build_portable_zip.py
```

输出位于 `archive/packages/`，不会再次堆放到根目录。打包工具会排除缓存、诊断日志和旧成品压缩包。
其他维护工具在 `tools/` 内；下载工具运行时需要网络，分析工具会读取资源并生成证据报告。
本地游戏日常运行不需要执行下载或分析工具。

## 调查资料

- [资源与来源调查](docs/调查报告.md)
- [引擎分析](docs/引擎分析.md)
- [公开资源发现报告](docs/公开资源发现报告.md)

调查报告记录的是当时的静态分析结果，不能用文件名或网站标签证明地图来源、真实性、作者或 AI 使用情况。
已验证的浏览器运行范围为 GTA V 沙盒；其他模式尚未逐一验证。

# GTA 浏览器离线版

本仓库保存服务器、网页和多人同步桥源码。游戏资源目录统一命名为 `gta5data/`，
整个目录已被 Git 忽略，不随仓库上传。页面与工作线程源码在 `client/`，
本地服务器将它们映射到浏览器原有路径；更换资源目录名称不会改变页面 URL。

从仓库克隆后，可直接构建独立 Java 服务端；运行 GTA 客户端还需要自行准备同版本的
`gta5data/` 资源，仓库不提供游戏数据、WASM、字体、Python 便携运行环境或成品压缩包。

启动服务器后，使用支持 WebGPU 和该版本 WebAssembly 的浏览器打开游戏。
已在 Chrome 154 / macOS 上验证 GTA V 沙盒可以进入游戏，菜单繁体中文显示正常。
游戏引擎构建为 `8b0b5899ed`；资源快照采集于 2026-10-06。

## 桌面启动器

新增 Tauri 2 桌面界面，可选择玩家自己的资源包，自动识别外层 `mirror`、任意站点目录或 `b/data` 子目录，
校验并准备隔离运行引擎后，在默认浏览器启动游戏。应用嵌入本项目 `client`，不使用资源包的 `index.html`；
用户无需手动运行 `serve_local.py`，也无需安装 Python。原游戏资源继续只读使用。
使用和构建说明见 [桌面启动器](desktop/README.md)。

## 脚本启动游戏

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
python3 serve_local.py --start-room-server --room-server 127.0.0.1:8787 --instances 2 --open
```

如果已单独启动 Java 服务，则省略 `--start-room-server`：

```sh
python3 serve_local.py --instances 2 --multiplayer --room-server 127.0.0.1:8787 --open
```

默认连接公网战局 `183.66.27.21:47485`，客户端不需要本地 Java 或 WebSocket 服务。
从主页点击“加入在线战局”或按 `O`，填写昵称、服务器地址和角色预设，连接成功后在同一页面进入游戏。
地址框只显示 `IP:端口`，连接协议与路径在内部处理；昵称、地址和角色预设会自动保存在浏览器本地存储。
右上角战局跳转和独立大厅页面已移除。在线加载显示“加入战局中”，只有一个旋转图标。
在线角色可选随机男女 NPC 或男女自由模式角色；随机服饰只生成一次，随后同步相同的外观。
输入模态框时不会触发游戏操作，在线入口屏蔽 Shift+P、帧率及调试按键。

多开测试使用不同 localhost 端口，隔离缓存、存档和引擎广播频道。
测试出生点仍在 `(711.5, -1088.1, 22.4)` 附近，间距两米；服务端分配位置并校验移动。
断线在 60 秒内可恢复相同身份、生命值、计分、位置和服饰，不再重新生成玩家。
刷新 `/play/` 会显示“恢复战局中”，先恢复服务器身份及完整角色快照再启动游戏，保留原模型、服装和朝向。
从主页重新提交角色选择属于新加入；恢复凭据仅保存在当前标签页，不与其他页面共享。
每个游戏页独占远程连接和桥接，避免同端口多标签页串用角色状态。
新版采用五秒应用心跳、二十五秒无响应自动重连、十秒完整战局快照；
网络恢复或标签页重新显示时会及时重连，过期身份凭据会自动重新加入。
服务端在 15 秒内未收到加入请求，或 30 秒未收到有效应用消息时主动关闭连接并释放读写线程；
正常五秒 JSON 心跳可保活，浏览器自动回应的协议 PONG 不会掩盖页面脚本停滞。
进入游戏后，连线、角色恢复、阵亡和重生提示通过游戏原生通知显示；引擎加载中或通知不可用时使用网页提示。

### 局域网查看

`serve_local.py` 默认监听 `0.0.0.0`，启动时打印本机和局域网访问地址。
默认战局地址是 `183.66.27.21:47485`。`--room-server auto` 仅用于开发时根据访问 IP 选择同机战局；
正常玩家不需要在本机启动 Java。可以显式指定其他远程战局地址。

```sh
python3 serve_local.py --host 0.0.0.0 --port 8010 --instances 2 --room-server 127.0.0.1:8787 --start-room-server
```

其他设备可访问 `http://本机局域网IP:8010/multiplayer/`；大厅不需要加载游戏。
实际 GTA 引擎需要浏览器的安全上下文，普通局域网 HTTP 不支持所需的 WebGPU/共享内存。
玩家可以在自己电脑用 localhost 游戏客户端，或给局域网游戏页部署受信任的 HTTPS。
仅本机使用时改为 `--host 127.0.0.1`。

### 实现与限制

服务端维护权威生命值、普通枪械射击间隔、移动预算、命中、击杀计分、死亡和四秒重生。
客户端上报自己的状态和射击射线，不能自行指定命中目标、修改其他玩家生命值或宣布击杀。
伤害、死亡、重生和断线恢复已经通过本地及真实公网协议测试；游戏内视觉效果仍需实测。
基础行为快照包括持枪、瞄准方向、装填、跳跃、蹲下和冲刺，由服务器校验、保存并广播，其他客户端只应用服务器快照。
远端角色会确认实际装备并限频重试；射击脉冲和弹夹减少用于捕获单发，换枪时先发送对应状态再发送射击。
服务端在连接确认时下发武器伤害与冷却规则，客户端按同一冷却及发送余量排队，最终判定仍由服务端执行。
服务端回执区分命中、未命中和拒绝，普通加特林已加入规则，未知武器会明确提示而不会静默零伤害。
客户端本地战斗日志只记录射击序号、武器哈希和服务器判定，便于区分上报失败、拒绝与未命中。

客户端调用游戏自身角色命令显示远端实体、服饰、移动和普通枪械射击效果。
存活替身不会在各端独立被击杀，死亡及重生统一应用服务端结果。
射击转播使用零伤害弹丸和瞄准姿态；不调用会额外产生默认伤害实弹的原生开火任务。
客户端每次更新均核对替身实际死亡与血量状态；服务器仍存活时修复本地意外倒地，服务器宣布死亡才允许倒下。
战斗状态按每名玩家的服务端版本合并，旧存活、死亡或重生快照不能覆盖更新的判定。
公共引擎副本隔离单机脚本的角色换模入口，在线角色只初始化一次，角色所属脚本上下文保持稳定。
存档恢复等路径仍可能替换本地角色；模型稳定不匹配一秒后启动限频恢复，保留最后在线位置、朝向、服饰、武器和服务器血量。
恢复期间远端玩家和射击队列继续更新；换模暂未完成会再次尝试，不再永久等待或停止同步桥。
收到重生时同时恢复本地玩家、游戏状态、控制和画面淡入，避免实体复活后仍卡在单机医院黑屏流程；
重生使用服务器版本号，旧死亡快照不会再次杀死刚恢复的角色。

**当前仍是实验版。命中判定使用玩家胶囊与射线，服务端尚无墙体和地形碰撞数据，不能验证遮挡。**
**当前服务已接入载具和近战路径，但游戏内验收未完成。爆炸、全部动画与完整物理复制仍未完成，也不兼容原 GTA Online/FiveM 协议。**
远端跳跃与蹲下使用原生动作命令，空间位置仍按服务器坐标复制，不在每个客户端独立模拟同一角色物理。
实时传输保留 WebSocket；当前公网为 WS，WSS 需要另外部署 TLS 证书和通常配套的域名。

### 共同世界的后续范围

当前服务为 `0.3.2-world-experimental`，客户端使用启动器 `0.2.0` 或更新版本，默认最多八人。`WorldService` 统一处理命令，`WorldRegistry` 唯一保存实体、战斗、挂接、版本和租约；`CombatWorld` 只保留输入校验与冷却等规则运行数据，广播后的 `WorldProjection` 镜像已经移除。
新 `world_v2` 通过 WebSocket 传输分块快照与连续增量，客户端按世界 epoch、实体代际和版本过滤。已接入共享车辆的姿态、线速度、角速度、座位和驾驶权，以及指定客户端代算的区域 NPC／交通。
角色近战、环境生命候选和逮捕由服务器确认；死亡或被捕四秒后统一重部署。原生医院／警局重启及淡出受到在线模式约束，客户端不自行裁决世界死亡。
每个 256 米活动格登记八位路人、八位司机和八辆交通车；其他端抑制并清理未登记的随机人口，保留玩家、登记实体和任务对象。人口出生点仍使用实验性附近偏移，尚未完成全地图道路／地面选点验证。
状态批次每 100 毫秒最多 24 个实体，一个批次仅提交一个世界事务，坏输入全部回滚。服务器确认资源就绪后激活五秒租约，断线移交不复用旧所有者权限。

按当前测试部署要求，公网 `47485` 和 `47486` 都已更新 `0.3.2`，增加共同天气、时钟和共享警察规则。游戏入口从主页按 `O`，填写同一地址；默认 `183.66.27.21:47485` 已能使用统一世界与近战，不必改到另一个端口。
拳击采样读取真实引擎缓存输入、任务和动画相位；服务器自主寻找前方近战目标并判定。批准后可靠广播 `melee_event`，远端只播放资源中的拳击动画，不产生本地伤害；重复事件及旧生命实例不会再次播放或扣血。
实际游戏双端验收尚未完成，`game_sync=false` 与 `native_clone_transport=false` 保留。原生同步树没有有效的运行态就绪记录，因此当前使用统一组件适配路线，没有假设网络对象可直接调用。

```sh
python3 -B tools/build_multiplayer_server.py --output server/multiplayer-world-experimental.jar
java -jar server/multiplayer-world-experimental.jar --host 0.0.0.0 --port 47486 --max-clients 8
python3 -B tools/world_protocol_soak.py --jar server/multiplayer-world-experimental.jar --seconds 1800
```

持续验证工具只验证协议，不能代替两台 GTA 客户端驾驶、交互、环境事件与三十分钟玩法验收。当前用于开发测试，旧服务和引擎回滚副本仍保留。

系统级审计见 [原生网络复制可行性](docs/原生网络复制可行性审计.md)、
[游戏世界状态与资源](docs/游戏世界状态与资源审计.md) 与 [统一世界服务端设计](docs/统一世界服务端设计.md)。
原同步树、角色任务树、车辆控制节点、克隆创建／更新／删除及原生网络事件编码仍存在，
但原 peer I/O 有空实现、网络脚本上下文与对象初始化尚待验证，不能只换 Java 服务器地址恢复 GTA Online。
客户端新增只读的同步树／网络脚本上下文就绪观测，结果写入本地日志；不创建假网络对象或调用未验证的树应用函数。

旧服务只共享玩家和基础战斗；实验版已将 NPC、交通、抢车、上下车、加入快照与断线移交接到同一实体模型。
客户端仍参与受分配的 AI／物理模拟，环境报告只经过归属、版本、范围和下降候选校验。服务器没有地图碰撞、导航或独立 RAGE 仿真，不能把候选确认称为完全可信的服务器重算。

浏览器单机与公共战局分别加载启动器 `client/runtime/offline/game.wasm` 和 `client/runtime/online/game.wasm`，
原游戏目录的 `game.wasm` 仅作为只读构建输入。在线副本
增加已核对的实体命令导出和有效脚本线程回调。原始游戏资源和 WASM 保留不变。
原线上模式的主要数据包传输在此构建中为空实现，不能只替换私服 IP 恢复原 GTA Online。
证据见 [原线上模式审计](docs/原线上模式审计.md) 与 [角色同步接口审计](docs/角色同步接口审计.md)。

公共战局的暂停菜单接入原生 Scaleform 标题和详情，显示“公共在線戰局”、昵称、人数及连接状态。
这项表现适配保持原网络会话判断不变；当前只读记录中同步树和网络脚本上下文仍未初始化，
因此没有启用依赖官方会话的朋友、商城或云角色流程。实现与验证边界见
[伪线上菜单与模式审计](docs/伪线上菜单与模式审计.md) 和 [FiveM 参考](docs/FiveM参考与浏览器实现边界.md)。

拳击使用服务器确认的动作事件播放全身动画，并由原生通知显示命中、受伤及剩余战局生命值；
动作窗口内不会被同步行走任务覆盖。远端玩家副本持续核对引擎实际位置和朝向，
站立时取消残余移动任务，避免缓存已经收敛后被本机 NPC 行为带走。
这些代码与协议检查不能替代实际双客户端游戏验证，能力仍标记为实验。

重新构建与测试：

```sh
python3 tools/build_multiplayer_server.py
python3 tools/build_multiplayer_client.py
python3 -B tools/tests/test_multiplayer.py
python3 -B tools/tests/test_combat_world.py
python3 -B tools/tests/test_connection_timeout.py
python3 -B tools/tests/test_world_registry.py
python3 -B tools/tests/test_world_projection.py
python3 -B tools/tests/test_world_v2.py --jar server/multiplayer-world-experimental.jar
python3 -B tools/tests/test_vehicle_world.py --jar server/multiplayer-world-experimental.jar
python3 -B tools/tests/test_entity_batch.py --jar server/multiplayer-world-experimental.jar
node tools/tests/test_game_adapter.cjs
node --test tools/tests/test_public_session.cjs tools/tests/test_join_modal.cjs
node --test tools/tests/test_world_client.cjs tools/tests/test_world_engine.cjs
```

服务器只需要 JAR；客户端可用 `--game-dir` 指向玩家自己准备的完整浏览器游戏资源目录，
构建输出与本地服务的 `--runtime-dir` 必须一致，默认均为 `client/runtime/`。
使用说明见 [启动器资源隔离](docs/启动器资源隔离.md)。

## 目录说明

| 路径 | 用途 |
| --- | --- |
| `serve_local.py` | 本地服务器，仍可直接从根目录启动 |
| `Launch-Local.cmd` / `Start-Local.ps1` | Windows 启动脚本 |
| `client/index.html` | 实际使用的中文网页入口 |
| `client/multiplayer/` | 公共战局页面、共享快照桥和实体同步源码 |
| `client/loader.js` | 引擎加载工作线程源码，通过服务器映射到原 URL |
| `client/runtime/` | 本机生成的离线与在线引擎及校验记录，浏览器唯一 WASM 入口，不写入游戏目录 |
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

`gta5data/`、`runtime/`、`client/runtime/`、`archive/`、`docs/snapshot/` 和 JAR/ZIP 等生成文件都被 Git 忽略。
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
可以运行 `python3 -B tools/audit_online_world.py` 重新生成系统级只读证据，结果写入被 Git 忽略的 `docs/snapshot/`。

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

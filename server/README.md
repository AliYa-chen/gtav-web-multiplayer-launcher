# GTA V 统一世界实验服务端 0.3.2-world-experimental

## 0.3.2 共同世界规则

本版增加共同时间／天气和共享执法规则，`world_v2` 客户端须同时声明 `world_environment`、`shared_law`；
缺少能力时明确要求更新启动器，不能让旧客户端各自运行另一套警察或天气逻辑。
全局 `environment`、`law` 随快照和连续增量发送，各有独立版本，晚加入、重连和闲置客户端都会收到。
天气、时钟、通缉和派遣没有客户端直接写入口。

共享警员和警车登记在同一实体目录，服务端决定创建、目标、座位、仿真租约、伤害、撤警和重部署。
旧 epoch／代次、未激活租约、重复射击和过近冷却会拒绝；未经服务器通缉与共同警员确认的单机逮捕不触发死亡。
AI 枪械本地扣血被抑制，服务端确认活动警员报告后统一提交伤害。玩家抢警车后保留驾驶权，撤警不会删除其正在乘坐的车。

环境及执法仍为实验能力。当前警力派遣限定公共出生区 220 米，服务器没有 GTA 道路导航、地图碰撞或独立物理／弹道 LOS。
客户端执行受分配 AI／物理模拟，其报告只经过来源、租约、顺序、代次、冷却及确认位置范围校验。
实施及测试边界见 [世界规则迁移](../docs/服务器世界规则迁移.md) 和 [共同环境协议](../docs/统一世界环境协议.md)。

本版将 `WorldRegistry` 作为玩家、车辆与 NPC 的唯一实体事实；`CombatWorld` 保留输入序号、移动预算和枪械冷却，规则结果直接提交到注册表，旧 v1 消息也从同一状态产生。已删除广播后的独立玩家镜像。服务端仍是轻量 Java 协调器，NPC AI、道路选择、车辆物理和环境损伤来自指定 GTA 客户端的受限候选，服务器没有 RAGE 物理运行时或地图碰撞。

当前开发测试版最多八位玩家，公网 47485 和 47486 均已更新 0.3.1，原构建仍保留备份。独立部署可使用 47486 等测试端口。实际游戏内的车辆、NPC 和生命事件需两台 GTA 客户端继续验证，协议测试不能代替这项验收。`game_sync: false` 和 `native_clone_transport: false` 保留；`shared_population` 表示已有统一人口实体登记，不能据此认定原 GTA Online 网络层或完整 AI 已实现。

所有玩家连接同一台服务器后，输入昵称就会自动进入唯一的 `PUBLIC` 公共战局。战局常驻，即使没有玩家也保留；无需创建房间、输入房间码、准备或等待房主开始。地图固定为 GTA V，游戏使用沙盒模式。

服务端已经实现 WebSocket 连接、成员与聊天、角色状态和射击事件转发、新玩家状态快照及断线清理。新增服务端权威普通枪械伤害、击杀计分、四秒重生和六十秒身份恢复。真实游戏中的实体桥仍在试验验证，载具同步尚未实现。健康接口的 `game_sync: false` 表示真实游戏同步尚未完成稳定验证，`state_transport: true` 表示状态转发接口已经提供。

本服务使用自有协议，与原 GTA Online 的身份、会话及网络包协议不同。项目保留原网络代码，但其浏览器适配存在空实现；不能把本 JAR 当成兼容原 GTA Online 的私服。具体证据见完整项目的 `docs/原线上模式审计.md`。

## 部署独立 JAR

运行服务器只需要 Java 17 或更新版本和 `multiplayer-server.jar`。没有第三方库、数据库或 Python 依赖；服务器不需要游戏资源，也不加载 WASM 或渲染游戏。可以仅上传 JAR 到远程服务器。

Windows 可以双击同目录的 `Start-Server.cmd`，macOS 可以双击 `Start-Server.command`。这些脚本调用已安装的 Java；没有配置 Java 时会显示提示。
Linux 也可运行 `sh Start-Server.sh`。包中的 `VERSION.json` 和 `SHA256SUMS.txt` 记录版本与文件校验值。

Linux 或任意命令行：

```sh
java -jar multiplayer-server.jar --host 0.0.0.0 --port 8787
```

默认监听所有网卡的 TCP 8787 端口。部署后允许玩家访问该端口，按 `Ctrl+C` 关闭。客户端应填写服务器实际 IP 或域名，例如 `192.168.1.20:8787`；`0.0.0.0` 是监听地址。

启动后可以检查服务是否就绪：

```sh
curl http://127.0.0.1:8787/health
```

两份客户端都填写同一个 `服务器IP:8787`，连接后自动加入唯一公共战局。
客户端使用完整项目内的最新公共战局版本；只更换 JAR 不会自动更新客户端实体桥。

只供本机测试时：

```sh
java -jar multiplayer-server.jar --host 127.0.0.1 --port 8787
```

可用启动参数：

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `--host` | `0.0.0.0` | 监听地址 |
| `--port` | `8787` | 端口，范围 0～65535；0 表示系统分配，实际端口会打印到终端 |
| `--max-clients` | `8` | 同时连接上限，范围 1～8，也作为公共战局的最大人数 |
| `--idle-timeout` | `30` | 已加入玩家连续多久没有有效应用消息就关闭连接，单位秒，范围 1～300 |
| `--hello-timeout` | `15` | WebSocket 建立后发送 `hello` 加入战局的期限，单位秒，范围 1～300 |
| `--help` | — | 显示帮助并退出 |

战局、成员和最新状态只保存在内存中。断线六十秒内可以用恢复凭据保留身份、生命值、分数与位置；服务器进程重启后需要重新加入。空战局一直存在。

## 玩家连接与本机多开

每位玩家在自己的电脑上运行完整本地项目，从首页进入“多人”，填写公共服务器的 IP 与昵称。连接成功后自动加入公共战局，连接成功后在同一页面进入在线 GTA V 沙盒，不再保留大厅标签页。

也可以在完整项目根目录直接打开多人页面：

```sh
python3 serve_local.py --multiplayer --room-server 192.168.1.20:8787 --open
```

本机模拟两个用户并一起启动 Java 服务端：

```sh
python3 serve_local.py --start-room-server --room-server 127.0.0.1:8787 --instances 2 --open
```

该命令启动本机 Java 服务与两个本地 HTTP 实例，通常使用 8000、8001 两个端口；端口占用时会自动顺延并打印实际地址。两个页面使用不同端口的浏览器存储与引擎频道，可填不同昵称进入同一公共战局。按 `Ctrl+C` 一起关闭由该命令启动的 Java 服务和本地实例。`--instances` 支持 1～8 个实例。

如果 Java 已单独运行，则复用现有公共服务器：

```sh
python3 serve_local.py --instances 2 --room-server 127.0.0.1:8787 --open
```

完整 Windows 项目也可使用自带的 Python：

```bat
runtime\python.exe serve_local.py --start-room-server --room-server 127.0.0.1:8787 --instances 2 --open
```

`--start-room-server` 只启动 `localhost` 或 `127.0.0.1` 上的本机服务；远程 JAR 需要在远程机器独立运行。可以用 `--java` 指定 Java 可执行文件路径。

游戏资源仍由每位玩家的本地 `serve_local.py` 读取。远程 JAR 的 HTTP 首页是服务状态页，不能提供游戏资源。浏览器连接原生服务使用 `ws://服务器IP:8787/ws`；通过 HTTPS 托管页面时需要用支持 WebSocket 升级的 TLS 反向代理提供 `wss://`。服务端当前未提供 WebRTC 信令或 TURN。

## HTTP 与 WebSocket 接口

| 路径 | 返回内容 |
| --- | --- |
| `GET /` | 中文服务状态页面 |
| `GET /health`、`GET /api/multiplayer` | 健康统计和能力 |
| `GET /world` | 统一实体的一致只读快照，含 epoch、版本、组件、租约和删除记录 |
| `GET /ws` | RFC 6455 WebSocket，UTF-8 JSON 文本协议版本 1 |

健康统计包含：

| 字段 | 含义 |
| --- | --- |
| `protocol: 1` | 协议版本 |
| `clients` | 已建立的 WebSocket 连接数 |
| `players` | 公共战局当前在线人数；不包含保留身份的断线玩家 |
| `retained_players` | 内存中保存的身份总数，包含在线玩家和六十秒内可恢复的断线玩家 |
| `state_players` | 公共战局中已有有效最新角色状态的玩家数；离开后移除 |
| `shot_events_received` | 本次服务运行中通过校验和限流的射击事件累计数 |
| `rooms: 1`、`public_session: true` | 唯一公共战局始终保留 |
| `map: "gta5"` | 固定地图 |
| `state_transport: true` | 状态转发已实现 |
| `game_sync: false` | 真实游戏同步尚未完成稳定验证 |
| `idle_timeout_seconds`、`hello_timeout_seconds` | 当前应用消息空闲超时与初次加入期限 |

健康统计不包含姓名或角色位置。`capabilities` 为 `public_session`、`chat`、`player_state`、`shoot_events`、`appearance`、`combat`、`resume`、`heartbeat`、`snapshot`、`actions`、`combat_feedback`、`weapon_rules`、`world_registry`。`/world` 的游戏实体坐标来自已经确认的公共战局状态，不包含恢复凭据；本版仍是已确认玩家的投影视图。

## 公共战局协议

所有消息通过 `type` 区分。连接后先收到 `welcome`，其中含 `protocol`、`client_id`、`capabilities`、`public_session: true` 和公共战局的 `room` 信息。

客户端消息：

| 消息 | 字段及行为 |
| --- | --- |
| `hello` | `{ "type": "hello", "name": "玩家昵称" }`；设置昵称并自动加入 PUBLIC，回复 `profile`，广播成员状态并发送最新世界快照 |
| `join_room` | 可选的重新加入请求；只允许 `{ "type": "join_room", "room_id": "PUBLIC" }` |
| `leave_room` | `{ "type": "leave_room" }`；离开战局并清除自己的最新状态，WebSocket 仍保持连接，可再次发送 `hello` 加入 |
| `chat` | `{ "type": "chat", "text": "聊天内容" }`；只向公共战局成员广播，昵称最多 24 个字符，聊天最多 500 个字符 |
| `player_state` | 自己的角色状态，字段见下节 |
| `shot_event` | 自己发出的射击事件，字段见下节 |

`create_room`、`set_ready`、`launch` 会返回 `error`，代码为 `public_session_only`。其它战局 ID、调试、故事模式及额外引擎参数不支持。

`room_state` 的 `room` 为以下结构：

```json
{
  "id": "PUBLIC",
  "name": "GTA V 公共战局",
  "map": "gta5",
  "max_players": 128,
  "phase": "launched",
  "host_id": null,
  "members": [
    { "id": "客户端 UUID", "name": "玩家昵称", "ready": false, "connected": true }
  ]
}
```

进入、离开、改昵称和断线后会广播新的成员名单。退出者收到 `room_state`，其中 `room: null`。断线后可恢复的身份会暂留名单并标记 `connected: false`；客户端用在线成员名单删除已离开或断线玩家的状态与本地实体，没有独立的 `player_left` 事件。

`chat` 广播包含 `room_id`、`sender_id`、`name`、`text` 和 UTC 时间 `time`。错误统一为 `{ "type": "error", "code": "错误代码", "message": "中文原因" }`。

## 角色状态与射击事件

客户端状态消息只允许以下字段：

```json
{
  "type": "player_state",
  "seq": 1,
  "position": [100.0, 200.0, 30.0],
  "heading": 90.0,
  "model": 1885233650,
  "health": 200,
  "weapon": 453432689,
  "shooting": false
}
```

射击消息只允许以下字段：

```json
{
  "type": "shot_event",
  "seq": 1,
  "origin": [100.0, 200.0, 31.0],
  "target": [110.0, 200.0, 31.0],
  "weapon": 453432689
}
```

必须先加入公共战局。`seq` 为 0～9007199254740991 的整数，同一连接内严格递增；状态和射击分别使用独立序号，退出重入同一连接后继续递增。重复或倒序的序号返回 `stale_seq`。

- 坐标为恰好三个有限数，每个值范围 -16000～16000。
- `heading` 为 0～360 的有限数；`health` 为 0～1000 的整数；`shooting` 必须为布尔值。
- `model` 和 `weapon` 为 0～4294967295 的无符号 32 位整数；客户端取得有符号哈希时需要转换为无符号值。
- 状态更新持续上限每秒 30 次，允许短时 60 次突发；射击持续上限每秒 30 次，允许短时 30 次突发。
- 连接整体消息持续上限每秒 80 次，允许短时 160 次突发。超限返回 `rate_limited`。
- 消息中不允许伪造 `player_id`、命中、击杀、受害者或其他玩家的生命值字段。转发的数据不是服务端权威伤害结果。

服务器向公共战局全体成员（含发送者）广播：

```text
player_state: { type, room_id: "PUBLIC", player_id, state: { seq, position, heading, model, health, weapon, shooting }, time }
shot_event:   { type, room_id: "PUBLIC", player_id, event: { seq, origin, target, weapon }, time }
world_state:  { type, room_id: "PUBLIC", states: [ { player_id, state } ] }
```

其中 `time` 为 ISO 8601 UTC 字符串。`world_state` 在加入时发送，包含现有玩家的最新角色状态；离开或断线后移除相应状态。客户端可用自己的 `client_id` 过滤自己的广播。

WebSocket 单条文本及累计分片上限 64 KiB；服务端检查掩码、控制帧、UTF-8、JSON 格式及字段，拒绝二进制消息，并提供定时心跳和慢连接清理。

## 源码、构建与验证

`server/` 中的交付文件为 `multiplayer-server.jar`、Windows/macOS 启动脚本、本说明和 `src/` 源码。部署可只使用 JAR；源码不参与运行，修改源码后需要重新构建。

Java 源码位于 `src/main/java/offline/multiplayer/Main.java`。完整项目根目录提供构建工具：

```sh
python3 tools/build_multiplayer_server.py
```

构建使用 JDK 的 `javac --release 17` 编译，由标准 ZIP 格式封装可执行 JAR，不需要 Maven 或 Gradle。运行已经构建的 JAR 只需要 Java 17+。

完整项目中的测试位于 `tools/tests/test_multiplayer.py`：

```sh
python3 -B tools/tests/test_multiplayer.py
```

测试使用真实 JAR 和多个 WebSocket 客户端，验证公共战局自动加入、晚加入快照、状态/射击/聊天转发、序号与字段范围、退出清理和帧格式。它验证服务协议；真实游戏角色互见、伤害及载具需要另外使用实际游戏客户端验证。

## 权威战斗与连接恢复（0.2）

声明支持 `combat` 和 `resume` 的客户端，发送：

```json
{"type":"hello","name":"玩家昵称","capabilities":["combat","resume"]}
```

`profile` 返回稳定 `client_id`、秘密 `resume_token`、状态与射击的已接受序号、出生点、
生命值、存活状态和计分。恢复凭据只保留在客户端当前会话存储中，不要输出到日志。
重连时在 `hello` 加入同一 `client_id` 和 `resume_token`，恢复服务端的原角色；
同一身份的旧连接会被替换。客户端只凭昵称或玩家 ID 不能恢复他人身份。

服务器事件包括 `combat_state`、`damage`、`death`、`respawn`、`correction`。
客户端自己的 `health` 仅为兼容字段，服务端不接受它来回血或更改生命值。
伤害按普通枪械规则、射击冷却和最近的玩家胶囊计算；拒绝远离角色的射击起点、
无近期状态、死亡射击和额外的受害者/击杀字段。移动采用累计速度预算，异常跳变会被纠正。
玩家死亡四秒后由服务器广播统一重生；枪械视觉转播不再独立扣血。

**当前射线判定没有墙体、地形和载具碰撞数据，不保证遮挡和真实游戏物理。**
载具、爆炸和近战未作为完整权威玩法实现；这是公共战局原型。
健康接口增加 `combat_authoritative: true`、`transport: "websocket"`、`resume_ttl_seconds: 60`。
`game_sync: false` 继续表示游戏内完整效果尚未完成稳定验证。

0.2.1 增加应用层 `ping` / `pong` 心跳与 `sync` 完整快照。
声明支持 `heartbeat` 的客户端可以发送 `{"type":"ping","nonce":1}`，收到同序号 `pong`。
已加入战局的客户端可发送 `{"type":"sync"}`，获取当前成员、角色及所支持的战斗快照，
不会重置玩家身份、生命值、分数或消息序号。浏览器客户端每五秒心跳、十秒快照，
二十五秒没有服务器响应则自动重连；网络恢复与页面激活时及时尝试恢复连接。

新增回归测试：`python3 -B tools/tests/test_combat_world.py`。测试覆盖公共协议、权威战斗、身份恢复和严格字段验证。

## 无响应连接清理（0.2.2）

HTTP 升级握手最多等待八秒。WebSocket 建立后，默认十五秒内必须用 `hello` 加入公共战局；空连接持续发送心跳也不能延长加入期限。

已经加入的玩家默认连续三十秒没有有效应用消息时会被断开。有效消息包括五秒一次的 JSON `ping`、有效角色状态、聊天和 `sync` 等通过校验的请求；加载游戏时只需正常发送心跳，尚无角色状态不会被误踢。坏 JSON、非法字段、过期序号、非法移动和被拒绝的射击都不刷新活性。

浏览器会自动回应 RFC 6455 控制帧 `pong`，即使页面脚本已经停止也可能继续回应。因此服务端分别检测传输和应用活性：控制帧只用于检查网络连接，不延长上述三十秒期限。

到期后服务端主动关闭 socket、退出读写循环并释放 WebSocket 连接名额。公共战局的该成员变为 `connected: false`，不计入在线人数或在线角色快照；其恢复身份、生命值、分数与位置仍保留六十秒，可凭原 `resume_token` 重连恢复。没有声明 `resume` 的旧客户端断线后立即移除身份。

本地验证可以临时缩短期限，例如：

```sh
java -jar multiplayer-server.jar --host 127.0.0.1 --port 8787 --idle-timeout 2 --hello-timeout 1
python3 -B tools/tests/test_connection_timeout.py
```

测试覆盖空连接、静默玩家、半帧阻塞、无效消息、五秒应用心跳、只有自动 `pong` 的连接、身份恢复及读写资源释放。实际部署保留三十秒默认值，允许加载和网络的短暂波动。

## 行为同步与射击回执（0.2.3）

角色状态可增加以下两个可选字段，原客户端不发送它们时保持兼容：

```json
{
  "actions": {
    "aiming": true,
    "reloading": false,
    "jumping": false,
    "ducking": false,
    "sprinting": false
  },
  "aim_target": [720.0, -1088.1, 23.1]
}
```

`actions` 必须完整包含这五个布尔字段，不接受额外键；`aim_target` 必须是三个有限坐标，范围与角色坐标相同。服务器验证后转发给其他玩家并保存至世界快照。这些表现字段不能指定受害者、扣血或击杀，也不代替射击射线。服务器重生时清除瞄准点并把行为状态重置为空闲。

支持回执的客户端在 `hello.capabilities` 声明 `combat_feedback`。每个被接收的射击事件会向射手单独返回 `shot_result`：

```json
{"type":"shot_result","seq":12,"weapon":453432689,"accepted":true,"hit":false}
```

命中时另含 `victim_id`、`damage` 与剩余 `health`；被拒绝时 `accepted: false`，并含 `reason` 错误代码和中文 `message`。能验证为合法整数时会附上原 `seq` 和 `weapon`。原 `error` 事件仍保留；没有声明该能力的客户端不会收到新回执类型。伤害和死亡继续由服务端权威事件广播，客户端不能自行指定命中对象或用 `shot_count` 放大伤害。

项目自带的普通加特林 `WEAPON_MINIGUN`（`0x42bf8a85`）现支持即时命中，每条射击消息只计算一条射线、最多 25 点伤害。原枪冷却为 20 毫秒，现有射击消息限流仍生效；客户端较低采样频率不会触发补算多发。

未支持的武器返回明确的 `unsupported_weapon`，文案含十六进制武器哈希，不再静默广播零伤害。爆炸、近战、载具武器和未知枪型仍未扩展为完整权威玩法。回执可以区分消息被拒绝、合法射线未命中和真正命中，但当前判定仍没有地图遮挡。

## 服务端武器规则（0.2.4）

`welcome.weapon_rules` 提供服务端支持的完整普通枪械规则数组：

```json
[{"weapon":324215364,"cooldown_ms":100,"damage":35}]
```

数组中的武器哈希、最低射击间隔和单条射线伤害来自同一份服务端只读目录，与实际权威判定一致。客户端可以按 `cooldown_ms` 加少量网络发送余量安排射击，避免每把枪都用统一发送间隔。服务器仍严格检查枪械冷却、消息限流及射线，没有放宽几何或接受客户端自选的伤害和冷却。

命中的 `shot_result` 增加受害者战斗状态的 `revision`，与相应 `damage` 广播一致。因枪械冷却被拒绝时，`error` 和射手专属回执提供 `retry_after_ms`，表示服务端当前还需等待的毫秒数。其他拒绝原因不保证包含该字段。原客户端可以忽略 `welcome` 中新增的规则数组，不会收到额外的武器规则消息类型。


## 统一世界 v2 实验协议

客户端在 `hello.capabilities` 声明 `world_v2`，仍可发送已校验的 v1 玩家 `player_state` 和 `shot_event`。玩家实体 ID 由服务器分配，`profile` 含 `entity_id`、`world_epoch` 和所有权 epoch。`GET /world` 返回相同注册表的当前一致快照。

加入或发送 `world_sync` 后，服务器依次发送 `snapshot_begin`、一个或多个 `snapshot_chunk`、`snapshot_end`。同次快照绑定 `snapshot_id`、`world_epoch`、`cut_revision`，结束消息含该连接的 `stream_seq`；客户端完整接收后原子安装基线。此后 `world_delta` 含连续 `stream_seq`、世界提交号、完整确认实体、删除记录及 `scope_leave`。旧世界 epoch、旧实体 generation 或旧版本不能覆盖新状态；离开兴趣范围只卸载副本，不能当成世界对象删除。

动态兴趣按确认位置和固定格网选择，进入距离 300 米、离开距离 400 米。车辆和挂接乘客作为依赖集合一起发送，远处变更不会让客户端错误推断自身 `stream_seq` 丢失。恢复需要完整快照时使用 `world_sync`，当前实现不接受客户端任意指定远处兴趣区域。

所有权经历 `offered → entity_ready → active`，DTO 的 `ownership` 明确区分三种状态（另有 `unowned`）。当前所有者必须在五秒租约内以对应 `owner_epoch` 完成 ready，才可提交动态更新；断线立即撤销租约，新接手者使用新的 epoch 和 ready 门槛。没有模拟者时冻结最后确认状态，服务器不会伪装继续执行物理或 AI。

| 客户端消息 | 字段及作用 |
| --- | --- |
| `entity_ready` | `world_epoch, entity_id, owner_epoch`；确认当前邀请的资源和副本就绪 |
| `entity_input` | `world_epoch, entity_id, owner_epoch, input_seq, based_on_revision, transform, view?`；单实体兼容入口 |
| `entity_batch` | `world_epoch, updates:[1～24 个上述更新项，不重复实体 ID]`；每 100 毫秒合并更新，整个批次校验失败则全部回滚，成功只有一个世界事务 |
| `interaction_request` | `world_epoch, request_id, action, entity_id, expected_revision, target_generation?, seat?`；`enter_vehicle`、`leave_vehicle` 和实验性 `melee`；当前玩家由 session 推导，不能自报 actor |
| `simulation_result` | 当前 `world_epoch/entity_id/owner_epoch/input_seq` 与候选种类；下文限定对应字段 |

`transform` 固定为三维 `position`、单位四元数 `rotation`、三维 `velocity` 和 `angular_velocity`。车辆 `view` 只允许 `engine_on/lights_on`；未挂接 NPC 的 `view` 可含白名单武器、射击与五种动作和瞄准点。客户端不能写模型、座位、所有者、战斗组件、generation、创建或删除。挂接 NPC 的姿态由车辆事务同步，不允许独立移动；玩家继续使用统一服务校验的 v1 玩家输入。

批次更新使用独立每秒十次、短时二十次的限流预算，玩家状态仍为每秒三十次，连接整体仍为每秒八十条消息。三十次玩家更新加十次模拟批次／秒可共存；逐个高频上报所有人口会被限流。生命、交互和 ready 仍为独立消息。回执继续使用已有 `error`，交互另返回与 `request_id` 绑定的 `interaction_result`。每位玩家最多保留64条成功请求回执；同ID与相同内容重放仅返回原结果，不再次扣血、占座或提交世界变更；同ID换内容返回 `invalid_request`。交互基线允许同一生命周期内较旧的位置版本，服务端仍原子判当前座位、距离与方向；未来版本返回 `invalid_revision`，旧生命周期基线或不匹配的 `target_generation` 返回 `stale_generation`，避免公网传输延迟使所有高频移动目标都无法交互。恢复身份窗口内缓存保留，身份最终删除时清理。

服务器提供一辆固定测试 Blista，驾驶位和乘客位是原子事务，双方同时抢驾驶位只能一人成功。驾驶员断线释放驾驶位并保留车辆及乘客，接手需新租约；车辆姿态更新与附座乘客位置同时提交。驾驶位由 NPC 占用时，玩家可通过同一事务驱离 NPC 并占位；原 NPC 保留身份和血量、解除挂接站在车旁，新驾驶员使用新的邀请和 epoch。已有玩家占据驾驶位时仍拒绝争抢，客户端不能强制杀死 NPC 或篡改座位。

人口区域采用 256 米格网，在已确认玩家进入新格时建立固定目录的八位行人、八位驾驶 NPC 和八辆车，最多保留八个区域。出生点目前为测试性的附近偏移，不能替代地图道路和地面导航；指定引擎客户端可执行 wander／driver 任务，服务器验证租约和有限移动结果。无玩家附近的旧区域可按政策退役并生成删除记录。两个客户端不会各自请求创建一套任意模型人口。

候选结果严格限定为：

- `life_report`：只可报告自己的玩家角色，额外字段为 `reason: environmental/dead/arrest` 和 `health`，只能下降。死亡或逮捕进入服务端四秒重生政策；重复死亡报告不能不断延长重生期限。
- `entity_health`：只可由已激活的模拟者报告其 NPC，额外字段为 `health`，只能下降。
- `vehicle_damage`：只可由已激活的模拟者报告当前车辆，额外字段为 `engine_health/body_health`，不能回报修复或篡改座位。

上述候选都不是完整物理反作弊；服务器目前没有独立重算环境碰撞和 GTA AI。近战原型使用存活、两米距离、最多一点五米高度差、前方向量余弦至少0.15和七百毫秒冷却验证，单次最多二十点伤害；没有骨骼接触、格挡或武器近战规则。普通枪械射线可作用于同一登记表里的玩家及有模拟者的 NPC，但仍不包含墙体遮挡。

本机实验构建与测试：

```sh
python3 -B tools/build_multiplayer_server.py --output server/multiplayer-world-experimental.jar
java -jar server/multiplayer-world-experimental.jar --host 127.0.0.1 --port 47486 --max-clients 8
python3 -B tools/tests/test_world_registry.py
python3 -B tools/tests/test_world_v2.py --jar server/multiplayer-world-experimental.jar
python3 -B tools/tests/test_vehicle_world.py --jar server/multiplayer-world-experimental.jar
python3 -B tools/tests/test_entity_batch.py --jar server/multiplayer-world-experimental.jar
```


## 近战动作事件（0.3.1）

客户端同时声明 `world_v2` 和 `melee_events` 后，会收到服务端确认的 `melee_event`。固定动作标识为 `action: "punch"`，服务器不接受客户端选择任意动画、宣称命中或提交伤害。事件含唯一 `event_id`、请求 ID、世界 epoch、攻击者／目标的实体 ID 与 generation，及 `hit/damage/health/revision`。客户端按事件 ID 去重，并在应用前核对 generation；动作播放不能产生第二次原生伤害。

近战请求可以只发送意图：

```json
{"type":"interaction_request","world_epoch":"当前世界","request_id":"本次唯一请求","action":"melee"}
```

服务器从自己的当前实体事实选择前方两米内、高度差和角度合格的最近存活目标。找到目标时最多扣除二十点生命值；没有目标时确认挥空，仍广播动作，但 `hit: false`、`damage: 0`，目标与生命值字段为 `null`。服务器不把客户端本地瞄准结果直接视为命中。显式携带目标的请求仍严格检查目标基线／generation、位置、朝向和存活状态，拒绝结果仅发给请求者，不播放被拒绝的攻击。

攻击者必须存活并持有自己的有效租约，每次确认动作均消耗七百毫秒近战冷却，包括挥空。成功请求幂等缓存只重发原 `interaction_result`，不会再次产生动作事件、伤害或世界提交。没有声明动作能力的旧客户端不会收到新增事件类型；原伤害广播继续来自同一注册表。

`GET /health` 增加 `melee_requests_received`、`melee_events_approved` 和 `melee_hits` 三个汇总计数，用于区分意图没到服务器、被拒绝和确认动作未命中。计数不包含身份凭据、坐标或玩家名字。新增验证：

```sh
python3 -B tools/tests/test_melee_events.py --jar server/multiplayer-world-experimental.jar
```

这些测试验证消息、命中与幂等规则；游戏内实际挥拳动画仍由 native 适配器执行，需要真实客户端验证。

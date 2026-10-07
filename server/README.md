# GTA V 公共战局服务端 0.2.4-public

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
| `--max-clients` | `128` | 同时连接上限，范围 1～1024，也作为公共战局的最大人数 |
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

这些统计不包含姓名或角色位置。`capabilities` 为 `public_session`、`chat`、`player_state`、`shoot_events`、`appearance`、`combat`、`resume`、`heartbeat`、`snapshot`、`actions`、`combat_feedback`、`weapon_rules`。

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

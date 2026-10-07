# GTA V 公共战局服务端 0.1.0-public

所有玩家连接同一台服务器后，输入昵称就会自动进入唯一的 `PUBLIC` 公共战局。战局常驻，即使没有玩家也保留；无需创建房间、输入房间码、准备或等待房主开始。地图固定为 GTA V，游戏使用沙盒模式。

服务端已经实现 WebSocket 连接、成员与聊天、角色状态和射击事件转发、新玩家状态快照及断线清理。真实游戏中的实体桥仍在试验验证，伤害判定、击杀与载具同步尚未实现。健康接口的 `game_sync: false` 表示真实游戏同步尚未完成稳定验证，`state_transport: true` 表示状态转发接口已经提供。

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
| `--help` | — | 显示帮助并退出 |

战局、成员和最新状态只保存在内存中，服务重启后玩家需要重新连接。空战局一直存在。

## 玩家连接与本机多开

每位玩家在自己的电脑上运行完整本地项目，从首页进入“多人”，填写公共服务器的 IP 与昵称。连接成功后自动加入公共战局，再使用页面的游戏入口进入本地 GTA V 沙盒。

也可以在完整项目根目录直接打开多人页面：

```sh
python3 serve_local.py --multiplayer --room-server 192.168.1.20:8787 --open
```

本机模拟两个用户并一起启动 Java 服务端：

```sh
python3 serve_local.py --start-room-server --instances 2 --open
```

该命令启动本机 Java 服务与两个本地 HTTP 实例，通常使用 8000、8001 两个端口；端口占用时会自动顺延并打印实际地址。两个页面使用不同端口的浏览器存储与引擎频道，可填不同昵称进入同一公共战局。按 `Ctrl+C` 一起关闭由该命令启动的 Java 服务和本地实例。`--instances` 支持 1～8 个实例。

如果 Java 已单独运行，则复用现有公共服务器：

```sh
python3 serve_local.py --instances 2 --room-server 127.0.0.1:8787 --open
```

完整 Windows 项目也可使用自带的 Python：

```bat
runtime\python.exe serve_local.py --start-room-server --instances 2 --open
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
| `players` | 已加入公共战局人数 |
| `state_players` | 公共战局中已有有效最新角色状态的玩家数；离开后移除 |
| `shot_events_received` | 本次服务运行中通过校验和限流的射击事件累计数 |
| `rooms: 1`、`public_session: true` | 唯一公共战局始终保留 |
| `map: "gta5"` | 固定地图 |
| `state_transport: true` | 状态转发已实现 |
| `game_sync: false` | 真实游戏同步尚未完成稳定验证 |

这些统计不包含姓名或角色位置。`capabilities` 为 `public_session`、`chat`、`player_state`、`shoot_events`。

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
    { "id": "客户端 UUID", "name": "玩家昵称", "ready": false }
  ]
}
```

进入、离开、改昵称和断线后会广播新的成员名单。退出者收到 `room_state`，其中 `room: null`。客户端以成员名单删除已离开玩家的状态与本地实体；没有独立的 `player_left` 事件。

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

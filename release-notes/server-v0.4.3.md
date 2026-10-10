## English

**Category: Server · Version: 0.4.3-world-experimental · Java 17+**

Standalone authoritative shared-world server. GitHub Actions builds and checks the Java 17 JAR and deployment ZIP from the release commit. It is separate from the desktop launcher and does not require the game engine at runtime.

### Features and changes

- WebSocket sessions, identity recovery, world snapshots, stable entities and simulation ownership leases.
- Server-owned combat, respawning, seats, AI objectives, time/weather and law rules.
- Passenger exits preserve a driver's pending vehicle-control offer.
- Optional independently supplied collision/road/pedestrian data; game-derived world data is **not included** in this release.

Run with Java 17 or newer:

```sh
java -jar multiplayer-server-v0.4.3.jar --host 127.0.0.1 --port 8787
```

The default shared session supports up to eight players. Use a trusted HTTPS/WSS reverse proxy for public hosting. See the server/deployment documentation in the source repository.

The generated provenance manifest records the exact source commit and artifact digests. The server deployment job checks the China/US experimental and main routes in that order, preserves world data, backs up old files and verifies HTTPS/WSS health, snapshots and heartbeats. A route already running byte-identical classes is verified without a restart.

`SHA256SUMS-server-v0.4.3.txt` verifies the JAR. Launcher releases are listed separately. This remains a custom experimental world protocol, not native GTA Online/FiveM compatibility.

[Server guide](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher/blob/main/server/README.md) · [Website](https://gtav.2t.hk/)

---

## 简体中文

**分类：服务端 · 版本：0.4.3-world-experimental · Java 17+**

独立权威共同世界服务端，由 GitHub Actions 按发布提交构建并核验 Java 17 JAR 和部署 ZIP。服务端与桌面启动器分开，运行时不需要游戏引擎。

### 功能与更新

- WebSocket 会话、身份恢复、世界快照、统一实体及模拟所有权租约。
- 服务端裁决战斗、重生、座位、AI 目标、时间/天气及执法规则。
- 乘客离车保留司机尚未确认的车辆控制邀请。
- 可加载独立提供的碰撞、道路及步行导航数据；本 Release **不包含游戏派生世界数据**。

使用 Java 17 或更新版本启动：

```sh
java -jar multiplayer-server-v0.4.3.jar --host 127.0.0.1 --port 8787
```

默认公共战局最多八位玩家，公网部署使用受信任的 HTTPS/WSS 反向代理。配置方法见仓库的服务端和部署说明。

自动生成的 provenance 文件记录精确源码提交和产物摘要。服务端部署步骤先检查中美实验线路，再检查正式线路，保留世界数据、备份旧文件并验证 HTTPS/WSS 健康、快照和心跳；已经运行相同 class 字节的线路只核验、不重启。

`SHA256SUMS-server-v0.4.3.txt` 用于核对 JAR。启动器单独发布。本项目使用实验性共同世界协议，不兼容原 GTA Online/FiveM。

[服务端说明](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher/blob/main/server/README.md) · [官网](https://gtav.2t.hk/)

## English

**Category: Server · Version: 0.4.4-world-experimental · Java 17+**

This release adds server-owned NPC perception and pursuit rules.

### NPC sight and pursuit

- NPC combat now requires the NPC's own confirmed line of sight and a target within 40 metres. A hidden target's current server position alone no longer authorizes combat.
- `WorldPerception` queries sight within 60 metres using static `SEE_THRU` material rules and the existing leased native geometry channel. Queries refresh no more often than 500 ms; confirmation lasts less than 1,000 ms. Unknown results, timeouts, and missing observers do not grant visibility.
- Generation or ownership changes and position drift beyond 0.75 m invalidate old query evidence. NPCs with no active `physics_queries` observer cannot shoot.
- Lost targets are pursued at their last confirmed position for up to 10 seconds. NPCs wait within 1.5 m of that point. Server-accepted attacks may supply a historical source position, without tracking later hidden movement.
- Active officers in the same law response share sightings through an order-independent, two-pass decision step. Shared intelligence supports pursuit; each officer still needs its own sight confirmation to fire.
- `/health` and `/world` expose actual `ai_perception` tracking, pending queries, results and limits. Final damage still passes through the existing `shot` obstruction checks.

### Compatibility and scope

Compatible with the existing launcher 0.2.16 client bridge. This update changes only the server and does not rebuild the launcher, adapt the original engine, modify player game resources, or replace independent world data.

NPC weapons retain the simplified 1,500 ms cooldown and 10-point damage model. Full field-of-view angles, cover, tactical coordination, dynamic vehicle occlusion, full-map navigation/collision and wider police dispatch remain unfinished. Native geometry retains its constrained client-observation trust boundary.

After publication, the existing workflow deploys US experimental before US main; the Actions audit records actual rollout success or rollback. China deployment requires separate explicit authorization and maintainer-side access.

### Validation

The final combined-workspace recheck passed 80 focused checks: perception, AI, navigation, collision/material continuation, police rules, perception integration and output isolation. All 12 original inputs in the expanded resource-audit baseline retained their sizes and SHA-256 values. The following detailed earlier implementation checks remain separate evidence.

- Java 17 `--release 17` compilation passed.
- 61 tests against a running JAR passed across multiplayer, combat, vehicles, world v2, public actions and world projection.
- 8 server-collision checks, 6 transparent-material continuation checks and 6 perception groups passed.
- 27 AI, pedestrian-navigation and police-service checks passed, including shared-memory survival after observer loss, target/lease changes, expiry, independent shooting authorization and stable combat-task revisions. The navigation checks included the local derived YNV spawn mesh.
- 62 existing JavaScript engine/state/collision checks and one additional visibility-bridge check passed. One running-JAR-to-JavaScript bridge check exercised both bridge layers with simulated native collision and verified `0.4.4` health and `ai_perception`.
- 20 read-only-output checks and 7 derived-output isolation checks passed.
- SHA-256 checks before and after the work matched for the original WASM, its three companion engine JS files and the game manifest. Component versions, bilingual release-note structure and source-content checks passed.

These are automated protocol, geometry and bridge checks. The native collision integration uses a simulated callback and does not establish in-game visual or movement behavior.

[Perception rules and limits](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher/blob/main/docs/npc-perception.md) · [Server guide](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher/blob/main/server/README.md)

---

## 简体中文

**分类：服务端 · 版本：0.4.4-world-experimental · Java 17+**

本版新增服务端 NPC 感知与追踪规则。

### NPC 视线与追踪

- NPC 进入战斗须有自身已确认视线，且目标在 40 米内。仅知道隐藏目标的服务端实时坐标不再足以授权战斗。
- `WorldPerception` 在 60 米内结合静态材质 `SEE_THRU` 规则和已有受租约约束的原生几何通道查询视线。查询最多每 500 毫秒刷新，确认有效期不足 1,000 毫秒；未知结果、超时及缺少观察者均不授予可见性。
- 代次或所有权变化、超过 0.75 米的坐标漂移会使旧查询证据失效。没有支持 `physics_queries` 的活动观察者时，NPC 不能开火。
- 丢失目标后最多追踪最后确认位置 10 秒，进入该点 1.5 米内后等待。已接受攻击可提供历史声源位置，但不会跟随之后的隐藏移动。
- 同一执法响应的活动警员通过与实体遍历顺序无关的两遍决策共享目击位置。共享情报支持追踪，每名警员射击仍须自己确认视线。
- `/health` 与 `/world` 新增真实的 `ai_perception` 跟踪、待处理查询、结果和期限状态。最终伤害继续执行已有 `shot` 遮挡检查。

### 兼容与范围

兼容启动器 0.2.16 的现有客户端桥。本轮仅更新服务端，不重新构建启动器、不适配原始引擎、不修改玩家游戏资源、不替换独立世界数据。

NPC 武器仍为 1,500 毫秒冷却、10 点伤害的简化模型。完整视野角度、掩体、战术协同、动态车辆遮挡、全地图导航/碰撞与扩大警方调度范围仍未完成。原生几何仍有受限客户端观测的信任边界。

发布后沿用 CI 先美国实验、后美国正式的部署顺序，实际成功或回滚以 Actions 报告为准。中国部署需要另行明确授权，并从维护者本机执行。

### 验证

合并工作区提交前再次通过 80 项定向检查，覆盖感知、AI、导航、碰撞/透明材质、警方规则、感知集成与输出隔离；扩展资源审计基线中的 12 份原始输入大小和 SHA-256 均不变。以下详细条目为此前实现阶段的独立验证记录。

- Java 17 `--release 17` 编译通过。
- 真实运行 JAR 的多人协议、战斗、载具、world v2、公共操作及世界投影共 61 项回归通过。
- 8 项服务端碰撞、6 项透明材质连续查询及 6 组感知检查通过。
- AI、步行导航与警方服务共 27 项回归通过，覆盖目击者失效后的共享记忆、目标/租约变化、到期清理、独立开火授权和稳定战斗任务版本；导航检查包含本地派生 YNV 出生区网格。
- 既有 JavaScript 引擎/状态/碰撞 62 项与新增 1 项视线桥检查通过。1 项真实 JAR 到 JavaScript 的跨层检查贯穿两层桥和模拟原生碰撞，并核对 `0.4.4` 健康状态与 `ai_perception`。
- 20 项只读输出保护和 7 项派生输出隔离检查通过。
- 原始 WASM、三个随包引擎 JS 和游戏清单的前后 SHA-256 均一致。组件版本、双语更新说明结构与源码内容检查通过。

上述证据来自自动化协议、几何及桥接检查。原生碰撞集成使用模拟回调，不等于真实游戏中的视觉或移动行为已验证。

[感知规则与边界](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher/blob/main/docs/npc-perception.md#简体中文) · [服务端说明](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher/blob/main/server/README.md)

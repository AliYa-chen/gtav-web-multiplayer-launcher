# Online-mode implementation roadmap / 线上模式实施路线图

## English

### Goal and evidence boundary

Build an original shared online world with a cloud-to-character entry sequence, stable sessions, cooperative activities and persistent characters/assets. The current resources provide substantial models, animations, map data and script candidates; they do not provide a working GTA Online backend. This design extends the project's own protocol and version-gated engine bridge. It does not promise compatibility with official services or execute original online scripts on Java.

Evidence date: **2026-10-11**. Read the [REA resource analysis](rea-online-feasibility.md) for measured archive/native findings. The source targets launcher **0.2.18** and server **0.4.6-world-experimental**; release and deployment evidence must be recorded separately. The bounded player, weapon and vehicle fixes in [core interactions](core-interactions.md) are implemented and tested; the remaining classes and phases below stay explicitly planned until their listed evidence exists. This roadmap does not claim official GTA Online or FiveM compatibility.

The audit decoded 1,528 RPF directories and found 1,762 YSC file records across the scanned directories, including duplicate/variant entries; 261 nested RPF entries were not recursively scanned. It validated the headers/page bounds of 22 representative scripts, not their complete bytecode control flow or runtime success. Names such as `freemode`, `fm_mission_controller`, `fm_race_controler`, `gb_delivery` and `gb_casino_heist` identify research candidates. An original server mission definition is safer to develop than assuming these scripts can run without their original session, statistics, inventory, cloud and scene dependencies.

### Existing foundation and proposed additions

| Area | Available in current source | Proposed work; not implemented |
| --- | --- | --- |
| Connections and world | `Main`, `WorldService`, `WorldRegistry`; one public world, reconnection, epoch/revision/stream sequence, leases, entity generations, snapshots/deltas | `SessionDirectory`, persistent character login, invitation/party membership and admission tickets |
| Entity projection | Version-gated `engine-bridge.js` and `world-engine-bridge.js`; local ped/vehicle creation, short-step locomotion, poses, seats, life, weapons, animations and owned AI tasks | Additional typed object, checkpoint, interior and scenario adapters after native lifecycle validation |
| World rules | `WorldEnvironment`, `WorldLaw`, `WorldAi`, population and collision/navigation services | `MissionService`, `ObjectiveValidator`, `IncidentService`, mission-scoped NPC/vehicle budgets |
| Combat/equipment | Server shot/melee/projectile rules, weapon catalog, bounded firing delivery, health; vehicle engine/body health and seats | `InventoryService`, server ammunition/reload ownership, consumables; `VehicleDamage` for tyres/windows/doors and repair rules |
| Identity/economy | In-memory session identity and bounded reconnect lifetime | `AccountService`, `CharacterStore`, `RewardLedger`, `GarageService`, durable ownership and audit trail |
| Entry presentation | Launcher 0.2.18 cloud/camera entry, `world: true` renderer gate, snapshot/character/collision gates and server acknowledgement | Further camera/interior/scenario adapters and broader cancellation/recovery evidence |
| Operations | GitHub builds/releases and existing deployment checks | Container packaging, database migrations, backup/restore drills and measured capacity checks |

An `ObjectState` record in the registry is not a complete object-rendering bridge. A vehicle's present health fields do not establish persistent garage ownership or detailed damage replication. Every new client capability must be negotiated; absent capabilities must fail admission or disable the particular activity explicitly.

### Cloud loading and entry sequence

The entry path introduced by launcher 0.2.17 and server 0.4.5 remains in the current 0.2.18/0.4.6 source targets; public release/deployment status is tracked separately. It uses the original title artwork, native `Cloudy 01` resource and owned script cameras. Before the world is ready, the original loading path remains active. The native camera starts only after the renderer/context gates. See [native cloud entry](native-cloud-entry.md) for the version-verified ABI, camera stages and actual evidence.

Readiness requires the complete world snapshot, matching character/generation, model placement, local collision, camera cleanup and negotiated server acknowledgement. A timer, rendered frame or camera success alone cannot admit the player. Attempts have bounded deadlines, stale-message rejection and owner-context cleanup. Once the high camera is rendering, a deliberately bounded random 5–10 second hold precedes three descent stages; reduced-motion entry skips the cinematic. The original player-switch state machine is not invoked because it changes population, dispatch and streaming.

Automated checks cover readiness, cancellation, stale identity, recovery and resource isolation. Existing local screenshots record visible clouds and native states record the descent/cleanup. Broader real two-client cold/warm load, reconnect and cancellation observations remain an O0 acceptance item; this roadmap does not turn protocol or native mocks into rendered gameplay evidence.

### Original mission definitions and scripts

Prefer declarative, bounded mission definitions plus typed server evaluators. Do not allow a client or downloaded definition to select WASM function indices, raw pointers, arbitrary JavaScript or original YSC execution. The following is an **original proposed schema**, not a file already consumed by the server:

```json
{
  "schema": 1,
  "id": "harbour-courier",
  "version": 1,
  "participants": {"min": 1, "max": 4},
  "requiredCapabilities": ["mission_v1", "inventory_v1"],
  "stages": [
    {"id": "collect", "kind": "pickup", "objective": "assigned-cargo"},
    {"id": "deliver", "kind": "delivery", "objective": "validated-depot",
     "deadlineSeconds": 300, "requires": "collect"},
    {"id": "settle", "kind": "durable_reward", "policy": "courier-basic-v1"}
  ]
}
```

`assigned-cargo`, `validated-depot` and the reward policy are server-owned catalog references, not client-selected item counts, coordinates or payment amounts. Bind their resolved versions and resource/build requirements into the mission instance at creation. Validate the complete definition before admission: bounded stages/spawns, existing references, allowed transitions, terminal states and no unbounded loops.

`MissionService` owns `instance_id`, immutable definition/version, participant character IDs, world epoch, instance revision, stage, server deadlines and entity bindings `(entity_id, generation)`. A suggested state machine is `AVAILABLE -> RESERVED -> PREPARING -> RUNNING -> COMPLETING -> COMPLETED`, with explicit `FAILED/CANCELLED/EXPIRED` branches. Membership changes, disconnect grace and retry eligibility are rules, not an implicit consequence of a simulation owner leaving.

Client `mission_intent` contains only a typed action, request ID and expected instance revision. Resolve identity from the authenticated session. `ObjectiveValidator` uses accepted world events and positions: ordered race gates need swept-segment crossing plus direction/lap checks; delivery needs current cargo entitlement, depot proximity, correct vehicle/participant and a valid deadline. A client `success`, native task status or rendered marker disappearing cannot commit completion. Teleport/reset discontinuities must invalidate crossing evidence.

Recommended first activities, in order:

| Activity | First deliverable | Missing prerequisites / completion evidence |
| --- | --- | --- |
| Time trial / race | Countdown, ordered gates, finish ranking, explicit reset penalty | Server clock, swept crossing, checkpoint/HUD presentation; no cash before ledger |
| Courier / taxi | One accepted assignment, pickup, destination and return/cancel | Inventory entitlement, passenger seat identity, damage/time rules, once-only payout |
| Cooperative escort / survival | Shared protectee or bounded waves, shared objectives and failure | Group membership, alive/generation checks, spawn budget, owner migration and cleanup |
| Police / ambulance / fire | One shared incident, assigned responders, resolved/cancelled outcome | Arrest/custody, incapacitation/revival and shared fire lifecycle are separate work |
| Shops / garages / businesses | Purchase/store/retrieve, ownership and replay-safe fulfillment | Durable ledger, inventory, vehicle asset identity and one-active-vehicle constraint |
| Heists / interiors | Small original staged activity before a large heist | Verified doors/props, interior/IPL barriers, synchronized scenes, reconnect checkpoints and all-party settlement |

Late joining must obtain the same mission revision and bound entities. Scope exit unloads local presentation, not mission ownership; mission entities remain pinned while required. Losing an owner pauses or reassigns simulation with a new fence. Cleanup affects only entities created/owned by that mission, not unrelated vehicles or player assets.

### Durable identity and rewards before a live economy

The current reconnect identity is insufficient for money, permanent inventory or vehicles. Implement stable account/character identity, one active character session, authorization and a minimal durable reward journal before enabling valuable payouts. Development-only scoreboards can precede this foundation if they are clearly resettable and grant no persistent entitlement.

Suggested PostgreSQL records: `accounts`, `characters`, `character_sessions`, `mission_instances`, `mission_members`, `reward_entitlements`, `ledger_entries`, `inventory_items`, `vehicle_assets`, `outbox`. Use integer currency units, database constraints and explicit schema versions. Separate account, character, network session and transient entity IDs. Never accept a nickname as durable ownership.

Original transaction pseudocode; names below are proposed interfaces:

```text
settleReward(authenticatedCharacter, instanceId, rewardSlot):
  BEGIN transaction
  lock mission instance and character/account rows in a fixed order
  verify durable completion, membership, entitlement and current writer fence
  derive amount/item grants from the instance's fixed server reward policy
  key = (instanceId, authenticatedCharacter, rewardSlot)
  INSERT ledger_entries(key, amount, policy_hash) ON CONFLICT DO NOTHING RETURNING id
  if a row was inserted:
    update balance/inventory atomically, enforcing bounds and ownership constraints
    insert outbox(event_id = ledger_id, payload = confirmed reward)
  else:
    read existing row; require identical entitlement and policy_hash
  COMMIT
  return the stored receipt; publish only committed events
```

The unique key belongs to the database. A Redis `SETNX` followed by a separate balance update is not an atomic payment. Stage completion and reward entitlement must also be durably recorded with a revision/fence check; do not create an entitlement merely from an in-memory success packet. On database failure remain `COMPLETING`, retry the same operation, and display pending settlement rather than successful payment. Never change the reward key to bypass a retry conflict.

Outbox workers deliver at least once; consumers deduplicate by event ID and revision. A crash after commit but before acknowledgement returns the same receipt after reconnect. For group payouts either commit all participant entitlements together or explicitly track each pending entitlement until settled. The single world loop must not block on SQL: submit bounded work, keep a pending state, and apply the result only if its world epoch/instance revision/fence still matches.

A cross-world transfer reserves the destination, freezes the source character, commits a single versioned ownership transfer, then admits the destination; an expired source process cannot write with an old fence. Avoid active-active character or world writes in the first deployment.

### Containers, PostgreSQL and Redis

A proposed Docker Compose layout contains a TLS gateway, one Java world process, PostgreSQL and optional Redis. This is a design, not an included runnable deployment. Containers improve packaging and supervision; they do not execute GTA vehicle physics or enlarge the supported player count by themselves.

| Component | Responsibility | Data/availability rules |
| --- | --- | --- |
| Java world | Serialize authoritative mutations, simulation leases, objectives and outgoing state | One writer process per world; preserve existing ordered semantics, with bounded queues |
| PostgreSQL | Identity, character/asset ownership, mission checkpoints, ledger and outbox | Durable volumes, migrations, backups and tested restore; constraints decide conflicts |
| Redis | Short-lived admission/session cache, rate limits, presence and wake-up hints | Rebuildable TTL data; Pub/Sub is not a durable mission log or balance store |
| TLS gateway | HTTPS/WSS termination, route and connection limits | Verified certificates, health/readiness routes and graceful connection drain |
| Metrics/export jobs | Queue/tick/load metrics and scheduled durable backups | Separate credentials; no game-resource payloads or authentication tokens in logs |

Keep 50 ms entity state in the world process and fan it out over the existing protocol. Do not round-trip every entity tick through Redis or introduce a 5 ms distributed simulation clock. Redis loss must not silently erase balances or create another world owner. If coordination later permits takeover, use a durable monotonically increasing fencing token enforced at writes; a lease without fencing cannot exclude a paused old process.

Use internal container networks, least-privilege database users, secret files/environment injection, health checks and explicit startup migration gates. Pin tested image versions and define resource limits. Mount launcher-derived `server/world-data/` read-only; PostgreSQL/Redis writable volumes and logs must be separate from all game directories. No original RPF/WASM, generated geometry or credentials are committed with Compose files.

Migrations use an expand/backfill/contract sequence compatible with rolling application updates; destructive changes require a separately planned window. Drain a world before replacement, checkpoint only supported durable state, change world epoch on restart and force a fresh baseline. Roll back application code only while the schema remains compatible; test recovery from backups, not just backup creation. Existing US automatic experimental-then-stable deployment and separately authorized local China deployment remain separate from this infrastructure proposal.

### Milestones and acceptance gates

✅ marks only the listed completed scope; ❌ marks unfinished work and its required evidence.

| Order | Status | Deliverable and evidence |
| --- | --- | --- |
| O0 foundation | ✅ | Snapshot/epoch/lease gates, native cloud/camera entry and server acknowledgement; automated cleanup, stale-message and resource-isolation checks. |
| O0 interactions | ✅ | The bounded player movement, shot-delivery/projectile and seat/destruction fixes in [core interactions](core-interactions.md). |
| O0 runtime acceptance | ❌ | Broader real two-client load/reconnect/cancel and rendered movement/action observations. |
| O1 | ❌ | Minimal persistent identity, character session and reward ledger; Duplicate request/restart/concurrent-login tests; backup restore; no double credit |
| O2 | ❌ | Server inventory/ammunition, detailed vehicle damage and typed mission foundation; Unauthorized item/ammo rejection, late join, seat/owner change and damage revision consistency |
| O3 | ❌ | Race, courier, escort and survival activities; Two-client complete/fail/rejoin flows; shared outcomes; deterministic settlement receipt |
| O4 | ❌ | Shared emergency incidents, garages/shops, then original staged interiors/heists; Incident uniqueness, asset ownership, streaming barriers and per-stage recovery |
| O5 | ❌ | Capacity and wider-world readiness; Measured 2/4/8-client runs, actual game clients and failure injection before proposing larger caps |

Current `Main` defaults to and caps at **8 clients**, maintains every **50 ms**, and `WorldService` creates a registry with a **256-entity** limit. Interest selection uses 300 m entry/400 m retention and a grid prefilter while still scanning the snapshot; it is not a complete spatial index. Measure tick duration, queue age, snapshot/delta bytes, RTT, client frame time, memory, model streaming delay and mission/ledger latency. Replace repeated scans with a verified spatial index only if profiles justify it. No 32-player or whole-map performance claim follows from these static limits.

Run restart-during-payout, duplicate/reordered intents, late baseline, old owner packets, lease loss, Redis/database outage, full queues and owner migration during an objective. Use original-engine/client runtime acceptance for each native addition. Static collision and pedestrian navigation currently cover roughly the spawn area's 600 × 600 m; expand derived coverage and validate traversal before enabling arbitrary destinations. Detailed vehicle dynamics and restored original clone transport remain research projects, not consequences of adding containers or databases.

### Resource and release contract

All game resources and original engine files remain read-only. Apply any new ABI adaptation only to a launcher-managed runtime copy, validate every selected supported resource pack/version, and fail clearly for unsupported inputs. Guard outputs, reports and temporary files against symlink/hard-link aliases; publish from fresh temporary files atomically and compare original input hashes. Store derived geometry only outside game data, never in the repository.

This document records current source and remaining designs; publication/deployment evidence is tracked separately. Implementation commits must update the appropriate component version and bilingual release note, preserve automated build/deploy checks, and state actual runtime evidence. Local test harnesses stay ignored. A completed document is not a completed gameplay milestone.

## 简体中文

### 目标与证据边界

目标是逐步做出具有云层入场、稳定战局、合作活动、持久角色和资产的自有线上世界。现有资源提供大量模型、动画、地图数据与脚本研究线索，但没有一个可直接启动的 GTA Online 后端。方案沿用项目自己的协议和经过版本校验的引擎桥，不承诺兼容官方服务，也不把原线上 YSC 放进 Java 执行。

证据日期为 **2026-10-11**。实测目录与 native 证据见 [REA 资源分析](rea-online-feasibility.md)。当前组件版本为启动器 **0.2.18**、服务端 **0.4.6-world-experimental**。[三类核心交互](core-interactions.md#简体中文)中的有限角色、武器和载具修复已实现并完成对应检查；其余类和阶段仍须满足表中证据，不能据此宣称兼容官方 GTA Online 或 FiveM。

审计解读了 1,528 个 RPF 目录，共发现 1,762 条 YSC 文件记录，其中含变体/重复；261 条嵌套 RPF 尚未递归。22 份代表脚本验证了头部与分页范围，没有完整反编译控制流或运行原任务。`freemode`、`fm_mission_controller`、`fm_race_controler`、`gb_delivery`、`gb_casino_heist` 可用来安排后续审计，不能仅凭名称认定任务可玩。原脚本的会话、统计、库存、云存档与场景依赖必须逐项解决。

### 当前基础与需要新增的代码

| 领域 | 当前源码已有 | 拟新增，尚未实现 |
| --- | --- | --- |
| 连接与世界 | `Main`、`WorldService`、`WorldRegistry`；公共战局、恢复、epoch/版本/流序号、租约、代次、快照/增量 | `SessionDirectory`、持久角色登录、队伍/邀请及入场凭据 |
| 实体表现 | 版本固定的引擎桥；角色/车辆、小步移动、姿态、座位、生命、武器、动画及授权 AI 任务 | 经生命周期验证的物件、检查点、室内与场景桥 |
| 世界规则 | 环境、通缉、AI、人口、碰撞与导航服务 | `MissionService`、`ObjectiveValidator`、`IncidentService` 及任务实体预算 |
| 战斗/装备 | 射击/近战/抛射物规则、武器目录、有界射击送达、生命、车辆引擎/车身血量与座位 | `InventoryService`、弹药/装填/消耗品所有权；轮胎/玻璃/车门的 `VehicleDamage` |
| 身份/资产 | 内存会话与有限断线恢复 | `AccountService`、`CharacterStore`、`RewardLedger`、`GarageService` |
| 入场体验 | 启动器 0.2.18 云层/相机入局、`world: true` 渲染门槛、快照/角色/碰撞门控及服务端确认 | 更多镜头/室内/场景桥及更广的取消/恢复证据 |
| 运维 | 现有构建发布部署检查 | 容器打包、数据库迁移、备份恢复与容量测量 |

注册表有 `ObjectState` 不等于已有完整物件表现桥；车辆健康字段不等于车库产权或精细损坏。新能力必须通过协议协商，不支持时明确拒绝相关活动或关闭该项能力。

### 已实现的“看云”入局

启动器 0.2.17、服务端 0.4.5 引入的原生入局已由当前 0.2.18/0.4.6 源码目标继续保留；公开发布/部署状态另行记录。使用原标题画面、`Cloudy 01` 云层和本次尝试拥有的脚本相机；世界未就绪时保留原加载流程，渲染与上下文门槛通过后才启动相机。经过版本核对的 ABI、相机阶段及实际证据见[原生云层入局](native-cloud-entry.md#简体中文)。

就绪须同时满足完整世界快照、匹配的角色/代次、模型放置、本地碰撞、相机清理和协商后的服务端确认，计时器、首帧或相机成功不能单独放行。每次尝试保留有界期限、旧消息拒绝和所属上下文清理。高空相机开始渲染后有意随机停留 5–10 秒，再执行三段下降；减少动态效果模式跳过镜头。不调用会改变人口、调度和流送的原始角色切换状态机。

自动检查覆盖就绪、取消、旧身份、恢复与资源隔离；已有本机截图记录可见云层，原生状态记录下降与清理。更广的真实双客户端冷/热加载、重连和取消观察仍列为 O0 验收，不能把协议或 native mock 当作双端画面证据。

### 自有任务脚本与服务端状态机

先做受限的声明式任务定义和类型化规则执行器。英文 JSON 是原创拟议格式，现有服务器尚不读取。例子表达“领取指定货物 → 五分钟内送至指定站点 → 按服务器规则结算”，其中物件、站点和奖励都是服务器目录引用，不接受客户端指定金额、坐标或物件数量。创建实例时固定定义版本、资源构建要求和奖励规则；提前检查阶段/生成上限、引用、终态和循环边界。

`MissionService` 保存实例 ID、定义版本、角色参与名单、world epoch、实例版本、阶段、服务端截止时间和 `(entity_id, generation)` 绑定。建议状态为 `可接取 → 已保留 → 准备 → 进行 → 结算中 → 已完成`，并有失败、取消、过期分支。离队、断线宽限和重试条件须明确定义；模拟者离线不能自动使任务消失。

客户端仅发送动作意图、请求 ID 和期望版本，身份来自鉴权会话。`ObjectiveValidator` 使用服务端已经接受的位置与事件：竞速检查有方向、有顺序的扫掠轨迹穿越、圈数和时间；交货检查当前货物权利、站点距离、车辆/参与者及期限。客户端成功消息、native 任务状态、标记消失都不能直接完成任务；传送或重置造成的轨迹跳变不能算穿过检查点。

| 建议顺序 | 第一份完整功能 | 必须补齐的范围 |
| --- | --- | --- |
| 计时赛/竞速 | 倒计时、顺序检查点、排名、重置惩罚 | 服务端时钟、扫掠到点判定、检查点/HUD；账本完成前不发持久货币 |
| 快递/出租车 | 唯一任务、领取、送达、取消/归还 | 库存权利、乘客座位身份、损坏/时间规则、一次结算 |
| 合作护送/生存 | 共享保护目标或有上限的波次 | 队伍、生命代次、生成预算、所有权迁移、回收 |
| 警察/救护/消防 | 一份共同事故、响应者分配、结案 | 羁押、濒死/救治、共同火情生命周期分别研发 |
| 商店/车库/产业 | 购买、存取、产权与幂等交付 | 持久账本、库存、车辆资产 ID、一车只激活一份 |
| 室内任务/抢劫 | 先做原创的小型分阶段活动 | 门/物件、室内/IPL 就绪屏障、同步场景、阶段恢复和团队结算 |

晚加入取得同一任务版本和绑定实体。离开兴趣范围只卸载本地表现，不取消产权；任务仍需的实体必须保留。模拟者失去租约后暂停或带新 fence 重新分配，任务回收只能删除本任务拥有的实体，不能删除无关车辆或玩家资产。

### 先补持久身份与奖励账本，再开放正式经济

当前断线恢复身份不能承担永久金钱、库存和车辆。先实现稳定账号/角色、一角色单活动会话、鉴权和最小持久奖励日志，再开放有价值的奖励。可重置且不产生持久资产的开发计分可以提前做。

建议 PostgreSQL 存储账号、角色、角色会话、任务实例/参与者、奖励权利、账本、库存、车辆资产和 outbox。货币用整数单位，数据库约束负责最终冲突判定；账号、角色、连接会话、瞬态实体分开标识，昵称不能作为产权。

英文 `settleReward` 为原创伪代码：同一 SQL 事务按固定顺序锁任务与角色/账户，校验持久完成状态、成员、奖励权利和写入 fence，读取实例固定奖励规则；唯一键为 `(instance_id, character_id, reward_slot)`。仅在账本插入成功时更新余额/库存，并写 outbox；重复请求读取原收据且检查权利与规则哈希一致。提交之后才发布已支付事件。奖励权利本身也必须随阶段完成经过版本/fence 校验持久化，不能凭内存中的客户端成功消息创建。

Redis `SETNX` 和另一次余额修改不构成原子支付。数据库失败时保持“结算中”，使用同一个键重试，不能换键绕过冲突。提交后响应前崩溃，重连返回同一收据；outbox 至少一次投递，消费者按事件 ID/版本去重。团队奖励要么一并记录全部权利，要么明确保存逐人待结算状态直到完成。

世界循环不能阻塞等待 SQL；用有界任务和待处理状态，结果返回时再校验 epoch、任务版本和 fence。跨世界迁移先预留目的地、冻结源角色、提交一次版本化所有权转移，再允许目的地进入；旧进程不能继续用过期 fence 写入。首个部署保持每世界/角色单写入者。

### 容器、PostgreSQL、Redis 各做什么

可规划 TLS 网关、一个 Java 世界进程、PostgreSQL 和可选 Redis 的 Docker Compose 组合。本文尚未提供可运行部署文件。容器负责打包与监管，不会因此运行 GTA 车辆物理或扩大当前人数上限。

| 组件 | 职责 | 数据与故障规则 |
| --- | --- | --- |
| Java 世界进程 | 串行权威修改、模拟租约、目标判定、状态广播 | 每世界一个写入进程，保留有序语义和有界队列 |
| PostgreSQL | 身份、产权、阶段检查点、账本、outbox | 持久卷、迁移、备份与恢复演练；约束决定冲突 |
| Redis | 短期入场/会话缓存、限流、在线状态、唤醒提示 | TTL 数据可重建；Pub/Sub 不是任务日志或余额存储 |
| TLS 网关 | HTTPS/WSS、路由、连接限制 | 校验证书、健康/就绪检查、连接排空 |
| 指标/备份任务 | tick、排队、负载和耐久备份 | 单独凭据，日志不含游戏数据和鉴权令牌 |

50 ms 实体状态保留在世界进程，经现有协议广播；不要每个实体每 tick 往返 Redis，更不要设计 5 ms 分布式仿真时钟。Redis 故障不能抹去余额或创建第二个世界写入者。以后如支持接管，写入端必须强制检查持久、单调增长的 fencing token，单纯有过期时间的锁无法阻止暂停后恢复的旧进程。

容器用内部网络、最小数据库权限、Secret/环境注入、健康检查、明确迁移门槛、固定验证过的镜像版本与资源限制。派生 `server/world-data/` 只读挂载，数据库/Redis 可写卷及日志与游戏目录完全隔离；不提交原 RPF/WASM、派生几何或凭据。

数据库迁移采用扩展、回填、收缩，保持相邻版本兼容；破坏性迁移另定窗口。替换世界前排空连接，只保存已支持的持久状态；重启换 world epoch 并发送全量基线。只有模式兼容时才能回滚应用，恢复演练须实际读取备份。美国先实验后正式的自动部署和中国另行授权后的本机部署，继续按既有规则处理。

### 阶段和验收

✅ 只表示该行列出的范围已完成；❌ 表示未完成工作及所需证据。

| 顺序 | 状态 | 交付范围与证据 |
| --- | --- | --- |
| O0 基础 | ✅ | 快照/epoch/租约门控、原云层/相机入局和服务端确认；自动清理、旧消息及资源隔离检查。 |
| O0 交互 | ✅ | [三类核心交互](core-interactions.md#简体中文)列出的有限移动、射击送达/投射物及座位/损毁修复。 |
| O0 实机验收 | ❌ | 更广的真实双客户端加载/恢复/取消，以及移动/动作画面观察。 |
| O1 | ❌ | 最小持久身份、角色会话、奖励账本; 重复请求、重启、并发登录、备份恢复、无重复入账 |
| O2 | ❌ | 服务端库存/弹药、精细车辆损坏、类型化任务基础; 非法物品/弹药拒绝、晚加入、座位/所有者变化和损坏版本一致 |
| O3 | ❌ | 竞速、快递、护送、生存; 双客户端完成/失败/恢复、共同结果、唯一结算收据 |
| O4 | ❌ | 共同紧急事件、车库/商店、原创室内/抢劫; 事故唯一、产权一致、流式就绪屏障、阶段恢复 |
| O5 | ❌ | 容量与扩大世界覆盖; 实测 2/4/8 客户端、真实游戏负载和故障注入后再考虑扩大人数 |

当前默认且最多 **8 人**，维护周期 **50 ms**，登记实体上限 **256**。兴趣范围为进入 300 米、保留 400 米，虽有格网预筛仍扫描快照，并非完整空间索引。记录 tick 时长、队列等待、快照/增量流量、RTT、客户端帧耗时、内存、模型流式加载与结算延迟，依据瓶颈再引入真正空间索引。这些静态上限不证明支持 32 人或全地图高密度运行。

故障测试覆盖结算中重启、重复/乱序意图、延迟基线、旧所有者数据、失去租约、Redis/数据库不可用、队列满和任务中的模拟者迁移。每个新 native 需要真实引擎/客户端验收。当前静态碰撞与步行导航约覆盖出生区 **600×600 米**，开放任意任务目的地前要扩展派生数据覆盖并验证通行。完整车辆动力学和原生 clone 传输仍是独立研发项目。

### 资源与发布约束

所有原游戏资源与原引擎始终只读。新增 ABI 适配只生成启动器管理的隔离运行副本，对玩家选择的每份受支持资源核验版本，不支持则明确失败。主输出、报告、临时文件都防止符号链接/硬链接别名写入，使用独立临时文件原子发布，核对原输入哈希。派生几何在游戏目录外生成且不提交。

本文记录当前版本和剩余设计，不代替组件发布，也不把文档完成等同于玩法完成。后续实现分别维护组件版本与双语更新说明，沿用构建部署检查，仅记录实际运行证据。本地测试材料继续忽略。

# Player, weapon and vehicle interactions

[English](#english) | [简体中文](#简体中文)

## English

Launcher 0.2.19/server 0.4.7 extend the three core interaction paths and retain the 0.2.18/0.4.6 fixes. This is a bounded improvement of the existing browser bridge and Java world, not a FiveM port or a claim that every GTA interaction is implemented.

### FiveM source reference

The review uses upstream commit [`a74c2cc`](https://github.com/citizenfx/fivem/tree/a74c2ccf0a56546dbb591b4545c643f56acebd3d), with the inspected files verified against its Git blob IDs. These are static source observations; the reported third-party browser port and desktop crossplay have not been independently verified.

| Area | What the inspected FiveM source does | What this project takes from it |
| --- | --- | --- |
| Player state | [`SyncTrees_Five.h`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/include/state/SyncTrees_Five.h) separates movement groups, current/desired orientation, task trees, health and armour. Task entries have active state, priority, depth and sequence. Some node bodies remain opaque. | Position updates alone cannot reproduce movement. Keep movement samples, animation tasks, lifecycle and combat state separate, and define which task owns the pose. |
| Entity lifetime | [`CloneManager.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/gta-net-five/src/CloneManager.cpp) checks player existence, pending deletion, duplicate object identity and `CanApplyToObject` before applying a clone. | Retain generation/epoch checks, model readiness, bounded retries and cleanup. Native handles are local projections of a server entity. |
| Weapons | [`ServerGameState.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/src/state/ServerGameState.cpp) parses separate weapon-damage, projectile and explosion events. Damage contains weapon, time, target IDs and optional hit-component/vehicle data; its damage event is cancellable. | Separate firing intent, projectile simulation, damage decisions and visual effects. Parsing a client's damage report is not independent hit validation; this project continues to calculate accepted damage on the server. |
| Vehicles | The same server source updates old/new seat occupancy, clears an occupant only when the recorded identity matches, and has component-control request/reply events. `CVehicleHealthDataNode` separately reads engine, tank, body and tyre state. | Seats need transactions and lifecycle cleanup; driving ownership is distinct from passenger occupancy. Detailed vehicle damage needs explicit components and verified geometry, not one guessed health value. |

No FiveM source or binary is added to the product. Its PC hooks and build-specific layouts are not browser WASM interfaces. Before any future direct code reuse, check the actual file's licence: the inspected repository is not uniformly MIT. See [source and licence boundaries](FiveM参考与浏览器实现边界.md).

### Players: short steps and action priority

Previously, the remote position was interpolated every bridge update while the walk task was refreshed only every 250 ms and aimed at the short movement endpoint. Static decoding of the supported engine confirms that the exported command creates `CTaskMoveGoToPointAndStandStill`: a nearby endpoint can put the task in its stopping region while coordinates continue to move.

The bridge now identifies new movement samples by entity revision or legacy sequence, starts locomotion on small horizontal movements and gives the animation task a target ahead of the movement direction. Rendered position still follows the accepted coordinates; the animation target does not authorize movement beyond them. It reuses an ongoing task, updates direction/speed when needed and stops after 160–300 ms without movement evidence. Heading follows the shortest angular path.

Respawn, generation changes, teleports and seat transitions reset the movement cache. Jump, aim, reload and melee tasks have explicit precedence so stale walking/idle tasks do not immediately overwrite them. Local 0.2.19 additionally uses a verified combined movement/aim native with firing disabled and clears old native task stacks across lifecycle changes. New tasks wait for the exact native seat or completed old-seat release. Full upper/lower-body blending and native task-tree replication remain unfinished. See [the further FiveM review](fivem-interactions-followup.md).

### Weapons: follow a shot through every layer

The path is native firing/ammunition observation → bounded worker queue → bounded browser queue → server weapon cadence → hit/geometry decision → authoritative health → harmless remote visuals.

- Remove the untimestamped `GET_PED_LAST_WEAPON_IMPACT_COORD` override. Its last impact may belong to a previous shot or weapon; current camera aim and the catalogue's range form the intent instead.
- Preserve observed ammunition decreases even when the native weapon fires faster than the published server cadence. The client no longer applies that cadence a second time and silently drops real shots. Delayed ammo updates are reconciled with already observed firing pulses; reload transitions are not additional shots.
- Keep at most eight pending intents in each client queue, with a one-second lifetime, and discard stale weapon/lifecycle inputs. The browser sends at a short transport interval; the server retains its own bounded cadence queue and validation.
- Use the declared weapon range instead of a fixed 100 m endpoint, with a millimetre tolerance for floating-point error at the server range boundary. Range remains subject to actual world/streaming query coverage; this does not promise 1,500 m native collision visibility.
- Fix physical projectiles expiring when a static-only collision query returns no obstruction and no query ticket. They now continue the authoritative swept character check. Incomplete or timed-out native queries remain failures, not permission to damage through a wall.

The current local 0.4.7 catalogue contains 91 original `weapons.meta` definitions and the unarmed loading alias: 92 entries. The three old entries without original metadata and all custom damage values are removed. Basic melee resolves the original action chain; discrete blasts use schema-validated `explosion.ymt` parameters. A catalogue entry does not imply complete gameplay. See [damage sources and limits](weapon-damage.md).

### Repeated explosive shots: local 0.2.19 follow-up

The original report described a grenade launcher's first hit damaging a player while later hits stopped reducing health even though the target remained alive. Local regressions identified two independent client failure paths:

- A native firing pulse or total-ammo decrease while shooting was discarded whenever the reload flag was also set. The bridge now preserves that evidence. A clip reset by itself during reload still cannot create a shot; existing delayed-counter and pulse deduplication remains active.
- Failed or expired collision jobs left pending native handles occupying all eight active slots. The bridge now continues to drain those handles separately, allowing new jobs to use eight active slots while limiting all unfinished handles to 64 and launches to four per tick. Late results from abandoned jobs are consumed once and never reported for a later job or identity. If the native engine keeps every handle unfinished, the total limit still stops further allocation until handles complete; unknown collision never becomes a clear path or damage permission.

These repeated-shot fixes use existing native exports. The same local update also changes server damage to original metadata and removes hit, damage and kill popups while preserving authoritative state. Launcher 0.2.19 accepts original rule amounts above 200; older launchers cannot accept the complete 0.4.7 rules. Local sampling, collision and Java combat regressions cover repeated shots and target respawn, without a new captured live-engine reproduction. The current action, equipment and precision additions are described in the component release notes.

### Vehicles: seats, motion and destruction

Entering a seat immediately attaches the player's confirmed transform to the car. Passenger entry/exit no longer resets the driver's accumulated movement allowance, which could reject a moving car's next update. Detaching a character resets that character's movement budget and inherited velocity.

When accepted damage reaches engine health −4,000 or body health 0, one registry transaction releases all occupants, stops the engine and motion, and revokes simulation ownership. A destroyed car cannot accept another occupant or a new simulation lease. Client presentation follows the destroyed state without recreating a native explosion or inventing occupant damage. Non-destroyed damaged vehicles retain their passengers.

The detached position uses a conservative offset based on vehicle heading and seat side. It is not a terrain-tested safe exit for every vehicle class. Claimed vehicles keep the existing retention policy; this change does not delete player assets or implement repairs.

Local 0.4.7 tracks sticky charges attached to confirmed shared PEDs and verified vehicle surfaces by parent generation/local offset. ASEA, BLISTA and POLICE provide 1,512 verified LOD0 triangles and 15 conservative unknown bounds. Nearest vehicle contacts obstruct character shots/projectiles; unknown bounds block without authorizing damage or attachment. Vehicle quaternion changes update sticky positions, and parent replacement/deletion expires them. Leased NPC forced-exit candidates remain validated before seat release. Complete model/component coverage and vehicle damage/fire/explosion formulas remain unfinished; engine/body health reports remain lease-checked client candidates. See [vehicle contact scope](vehicle-damage.md) and [further FiveM references](fivem-interactions-followup.md).

Launcher 0.2.19 applies original cosmetic torso blood once per confirmed health-loss revision, clears old-life marks and preserves original player/NPC death tasks. Dead NPCs are not frozen or reseated by repeated snapshots or ownership changes; revival resets AI state. The local player's native death-camera effect supplies shake/depth of field, without establishing the complete scripted overhead/pull-away sequence. The registry's engine −4,000/body 0 terminal policy is not a universal native explosion threshold.

### Next work, in order

| Priority | Status | Work and required evidence |
| --- | --- | --- |
| Character movement foundation | ✅ | New-sample movement, short-step targets, combined movement/aim, bounded stopping, shortest-angle heading and native task/lifecycle reset. |
| Weapon delivery and projectile lifetime | ✅ | Preserve confirmed shots across both client queues, current-aim intents, declared range and static-only unobstructed projectile continuation. |
| Original damage parameters | ✅ | Supported bullets, basic melee and discrete blasts derive damage from original metadata; NPC firing uses the same weapon path. No guessed damage fallback. |
| Vehicle seat and destroyed-state foundation | ✅ | Preserve driver allowance through passenger changes, reconcile established native NPC exits, and release occupants/ownership on destruction. |
| Character actions | ❌ | Bounded native actions, matching phases/blends, cover aim, same-ladder progress and living-ragdoll pose are implemented. Missing networks, complete transitions, climbing attachment and corpse pose remain deferred. |
| Combat detail | ❌ | Original hit components, ordinary armour/head props, bounded rewind, server ammunition/reloads/pickups and gas are implemented. Persistent burning and full native branches remain deferred. |
| Verified vehicle contacts and sticky following | ✅ | Three models, 1,512 real triangles, 15 unknown-bound blockers and generation/quaternion/local-offset parent tracking. Coverage remains incomplete. |
| Native injury/death presentation | ✅ | Cosmetic blood deduplication, player/NPC death-task retention and local death-camera shake/depth of field. |
| Vehicle damage | ❌ | Complete all-model/component geometry, bullet/blast damage, tyres, glass, doors, tank/fire/explosion rules, repair and safe exits. Engine/body reports remain lease-checked client candidates. |
| Character sticky attachments | ✅ | Confirmed shared-PED parent/local-offset following, rotation, current baseline and invalid-parent expiry. |
| Special equipment | ❌ | Complete bone/component attachment, mounted-weapon permissions, stun state, fuel trails, extinguishing and shared fire. A catalogue entry or visual effect does not implement the interaction. |
| Complete death sequence | ❌ | Scripted overhead/pull-away camera and general shared ragdoll synchronization. |

The local checks exercise the real Java rules and WebSocket protocol, the JavaScript bridge with native-call mocks, and read-only resource/output protection. Static native decoding identifies the task used by the supported engine. These evidence types are separate from actual two-client rendered animation; this update does not record a new rendered gameplay session.

## 简体中文

启动器 0.2.19/服务端 0.4.7 继续完善角色、武器、载具三条核心交互链，并保留 0.2.18/0.4.6 的修复，继续完善现有浏览器同步桥和 Java 共同世界。这不是 FiveM 移植，也不表示所有 GTA 交互已经完成。

### FiveM 源码对照

本次对照固定上游提交 [`a74c2cc`](https://github.com/citizenfx/fivem/tree/a74c2ccf0a56546dbb591b4545c643f56acebd3d)，读取的文件均核对 Git blob ID。这些是静态源码证据；第三方浏览器移植的进度和桌面跨端联机尚未独立核实。

| 类别 | 实际读到的 FiveM 做法 | 本项目采用的原则 |
| --- | --- | --- |
| 角色状态 | [`SyncTrees_Five.h`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/include/state/SyncTrees_Five.h) 分开处理移动组、当前/目标朝向、任务树、生命和护甲；任务包含活动位、优先级、树深度及序号。部分节点体仍未解码。 | 坐标同步不足以重建动作；移动样本、动画任务、生命代次和战斗状态需要分离，并规定当前由哪个任务控制姿态。 |
| 实体生命周期 | [`CloneManager.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/gta-net-five/src/CloneManager.cpp) 检查玩家是否存在、待删除记录、重复身份及 `CanApplyToObject`，再应用 clone。 | 保留代次/epoch、模型就绪、有限重试和清理；本机 native handle 只是服务端实体的投影。 |
| 武器 | [`ServerGameState.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/src/state/ServerGameState.cpp) 分开解析伤害、投射物和爆炸事件；伤害包含武器、时间、目标及可选部件/车辆字段，并允许取消。 | 开火意图、弹道、伤害裁决和特效分别处理。解析客户端伤害报告不等于独立验证命中，本项目继续由服务端计算获准伤害。 |
| 载具 | 同一服务端源码协调新旧座位，仅在乘员身份一致时清理占用，并定义部件控制请求/回复；`CVehicleHealthDataNode` 分开读取引擎、油箱、车身和轮胎。 | 座位需要事务和生命周期清理，驾驶权与乘客身份分离；细分损伤要有明确组件与经过验证的几何。 |

产品未加入 FiveM 源码或二进制。PC hook 与构建专用内存布局不是 WASM 接口。以后直接复用代码前须检查实际文件的许可；该仓库不能统一视作 MIT。详见[源码与许可边界](FiveM参考与浏览器实现边界.md)。

### 角色：小步移动与动作优先级

此前远端坐标每次更新都插值，但走路任务每 250 毫秒才刷新，目的地又是很近的位移终点。对受支持引擎的静态解码确认，该命令构造 `CTaskMoveGoToPointAndStandStill`；短目标可能让任务进入停止区域，而坐标仍在平移。

现在按实体 revision 或旧协议 seq 识别新移动样本，细小水平位移即启动走路，并将动画目标放在运动方向前方。画面位置仍跟随已接受坐标，动画目标不授予额外移动权限。连续移动复用任务，方向/速度变化及时刷新，160–300 毫秒没有移动证据后停止；朝向按最短角插值。

重生、代次变化、远距离位置纠正和上下车都会重置移动缓存。跳跃、瞄准、换弹及近战有明确优先级，旧走路/站立任务不会立即覆盖它们。本地 0.2.19 另使用经过验证的联合移动瞄准 native，并关闭开火；生命周期变化清理旧原生任务栈，先确认原生准确座位或完成旧座位释放，再安装新动作。完整上下身混合与原生任务树复制仍未完成，见[进一步 FiveM 对照](fivem-interactions-followup.md#简体中文)。

### 武器：逐层跟踪一发射击

链路为原生射击/扣弹观测 → 工作线程有界队列 → 页面有界队列 → 服务端射速 → 命中/遮挡 → 权威生命 → 远端无伤害表现。

- 不再用没有本次时间戳的 `GET_PED_LAST_WEAPON_IMPACT_COORD` 覆盖瞄准；它可能仍是上一发或上一把枪的落点。改用当前镜头方向与目录射程提交意图。
- 已观察到的扣弹不再因本机重复套用服务端冷却而丢失。延迟扣弹与已采集的射击脉冲去重，换弹过渡不计作额外射击。
- 两级客户端队列各最多八个意图，寿命一秒，清除旧武器/生命输入。页面仅做短间隔传输，服务端继续保留自己的有界队列、武器节奏与全部校验。
- 使用武器声明射程，取消固定 100 米终点；服务端容忍射程边界的毫米级浮点误差。实际伤害仍受地图/流式查询覆盖约束，不代表原生碰撞能看到 1,500 米。
- 修复物理投射物将“仅静态查询无遮挡、无需查询票据”误判为过期的问题，继续执行服务端角色扫掠碰撞。原生查询不完整或超时仍不能当作无遮挡。

当前本地 0.4.7 目录包含原版 `weapons.meta` 的 91 项与空手加载别名，共 92 项。移除没有原始元数据的三个旧兼容条目及全部自定义伤害值；普通近战追溯原版动作链，单次爆炸读取经过结构校验的 `explosion.ymt`。目录条目不表示完整玩法，见[伤害来源与范围](weapon-damage.md#简体中文)。

### 连续爆炸武器射击：本地 0.2.19 跟进

原始反馈是榴弹枪首发能伤人，目标仍存活时后续命中不再扣血。本地回归确认了两条独立客户端缺陷：

- 换弹标志同时存在时，原生开火脉冲及开火中的总弹药下降会被丢弃。桥现在保留这些射击证据；单纯换弹清空弹匣仍不能生成射击，延迟计数与脉冲去重继续生效。
- 失败或过期碰撞任务的待完成原生句柄占满八个活跃槽后，后续查询没有机会执行。现在单独继续轮询这些句柄，让新任务使用八个活跃槽，同时限制全部未完成句柄为 64 个、每次 tick 最多新建四个。旧任务/身份的迟到结果只消费一次，不转交新任务。如果原生引擎一直不完成所有句柄，总量上限仍会阻止继续分配，直到有句柄完成；未知碰撞绝不当作无遮挡或伤害许可。

这两项连续射击修复使用已有 native 导出。同一本地更新另将服务端伤害改为原版元数据，并取消命中、伤害和击杀小提示，保留权威状态同步。启动器 0.2.19 接受超过 200 的原版规则值；旧启动器无法接受 0.4.7 的完整目录。本地采样、碰撞与 Java 战斗回归覆盖连续发射及目标重生，尚未捕获用户实际引擎会话来确认唯一根因。本版新增动作、装备及精细战斗范围见各组件更新说明。

### 载具：座位、运动与损毁

上车立即将角色确认位姿对齐车辆。乘客上下车不再重置司机累计的移动额度，避免下一份行驶更新被错误拒绝。角色脱离座位时重置自己的移动额度和继承车速。

获准损伤达到引擎 −4,000 或车身 0 时，同一次注册表事务解除全部乘员、停机/清零运动并撤销模拟权。损毁车辆不能再入座或取得新模拟租约。客户端按损毁状态呈现，不重播原生爆炸，不凭空生成乘员伤害。普通受损、尚未摧毁的车辆继续保留乘员。

下车位置采用车朝向和座位侧的保守偏移，尚未对每种车型及地形做安全选点。已认领车辆保留原有保留策略，不因此删除玩家资产，也不提供维修。

本地 0.4.7 为已确认共享 PED 和真实车体表面的黏弹保存父代次及局部偏移。ASEA、BLISTA、POLICE 提供 1,512 个已核验 LOD0 三角形和 15 个未知形状保守范围；最近车体接触遮挡角色射击/投射物，未知范围阻断但不授权伤害或附着。车辆四元数变化更新黏弹位置，父实体删除/换代时过期；释放座位前仍校验租约 NPC 离车候选。完整车型/部件覆盖及车辆损伤/火势/爆炸公式仍未完成，引擎/车身生命上报仍是租约候选。见[载具接触范围](vehicle-damage.md#简体中文)与[进一步 FiveM 对照](fivem-interactions-followup.md#简体中文)。

启动器 0.2.19 按确认扣血修订应用一次原生躯干血迹，清理旧生命伤痕并保留玩家/NPC 原生死亡任务；重复快照及所有权变化不再冻结死亡 NPC 或放回座位，复活重建 AI 状态。本人原生死亡镜头提供抖动/景深，完整脚本俯视/拉远序列仍未确认。注册表“引擎 −4,000/车身 0”是本项目终止车辆状态策略，不能称为原游戏通用爆炸阈值。

### 后续顺序

| 优先范围 | 状态 | 待办与所需证据 |
| --- | --- | --- |
| 角色移动基础 | ✅ | 按新样本移动、小步动画前方目标、联合移动瞄准、有限停步、最短角朝向及原生任务/代次重置。 |
| 射击送达与投射物生命周期 | ✅ | 两级队列保留确认射击、当前瞄准、声明射程、静态无遮挡投射物继续飞行。 |
| 原版伤害参数 | ✅ | 支持的枪弹、普通近战和单次爆炸伤害由原始元数据生成，NPC 开火走相同武器路径，没有猜测伤害兜底。 |
| 车辆座位与损毁基础 | ✅ | 乘客变更保留司机移动额度、协调已确认原生入座后的 NPC 离车；确认损毁后释放乘员和所有权。 |
| 角色动作 | ❌ | 已完成有界原生动作、匹配相位/混合、掩体瞄准、同梯子进度与活体布娃娃；缺失网络、完整过渡、攀爬附着和尸体姿态仍待后续。 |
| 细分战斗 | ❌ | 已完成原命中部位、普通护甲/头部道具、有界回溯、服务端弹药/换弹/拾取及毒气；持续燃烧和完整原生分支仍待后续。 |
| 已核验车体接触与黏弹跟随 | ✅ | 三种车型、1,512 个真实三角形、15 个未知范围阻断及代次/四元数/局部偏移父实体跟随；覆盖仍不完整。 |
| 原生受伤/死亡表现 | ✅ | 血迹去重、玩家/NPC 死亡任务保留及本人镜头抖动/景深。 |
| 车辆损伤 | ❌ | 完整车型/部件几何、枪弹/爆炸伤车、轮胎、玻璃、车门、油箱/火势/爆炸、维修及安全下车；引擎/车身上报仍是租约候选。 |
| 角色黏弹附着 | ✅ | 已确认共享 PED 的父实体/局部偏移跟随、旋转、当前基线与父实体失效过期。 |
| 特殊装备 | ❌ | 完整骨骼/部件附着、车载武器权限、电击状态、铺油、灭火和共同火势；目录项或特效不等于交互已完成。 |
| 完整死亡序列 | ❌ | 脚本俯视/拉远镜头及通用共享布娃娃同步。 |

本地检查覆盖真实 Java 规则和 WebSocket 协议、替代原生调用的 JavaScript 桥回归，以及资源只读/输出保护。原生命令由静态解码确认；这些证据与双客户端实际渲染不同，本轮未新增实机动画记录。

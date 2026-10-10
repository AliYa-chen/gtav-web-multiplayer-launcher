# Player, weapon and vehicle interactions

[English](#english) | [简体中文](#简体中文)

## English

Launcher 0.2.18 and server 0.4.6 address specific defects in the three core interaction paths. This is a bounded improvement of the existing browser bridge and Java world, not a FiveM port or a claim that every GTA interaction is implemented.

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

Respawn, generation changes, teleports and seat transitions reset the movement cache. Jump, aim, reload and melee tasks have explicit precedence so stale walking/idle tasks do not immediately overwrite them. This does not provide full upper/lower-body blending or native task-tree replication.

### Weapons: follow a shot through every layer

The path is native firing/ammunition observation → bounded worker queue → bounded browser queue → server weapon cadence → hit/geometry decision → authoritative health → harmless remote visuals.

- Remove the untimestamped `GET_PED_LAST_WEAPON_IMPACT_COORD` override. Its last impact may belong to a previous shot or weapon; current camera aim and the catalogue's range form the intent instead.
- Preserve observed ammunition decreases even when the native weapon fires faster than the published server cadence. The client no longer applies that cadence a second time and silently drops real shots. Delayed ammo updates are reconciled with already observed firing pulses; reload transitions are not additional shots.
- Keep at most eight pending intents in each client queue, with a one-second lifetime, and discard stale weapon/lifecycle inputs. The browser sends at a short transport interval; the server retains its own bounded cadence queue and validation.
- Use the declared weapon range instead of a fixed 100 m endpoint, with a millimetre tolerance for floating-point error at the server range boundary. Range remains subject to actual world/streaming query coverage; this does not promise 1,500 m native collision visibility.
- Fix physical projectiles expiring when a static-only collision query returns no obstruction and no query ticket. They now continue the authoritative swept character check. Incomplete or timed-out native queries remain failures, not permission to damage through a wall.

The data audit still finds 91 records in the supported `weapons.meta`, plus three published compatibility rules and the unarmed alias: 95 entries, including tools, animals and environmental causes. The catalogue is not proof of 95 fully playable weapons. The metadata and physics generators remain source-consistent; they are not replaced with guessed weapon values.

### Vehicles: seats, motion and destruction

Entering a seat immediately attaches the player's confirmed transform to the car. Passenger entry/exit no longer resets the driver's accumulated movement allowance, which could reject a moving car's next update. Detaching a character resets that character's movement budget and inherited velocity.

When accepted damage reaches engine health −4,000 or body health 0, one registry transaction releases all occupants, stops the engine and motion, and revokes simulation ownership. A destroyed car cannot accept another occupant or a new simulation lease. Client presentation follows the destroyed state without recreating a native explosion or inventing occupant damage. Non-destroyed damaged vehicles retain their passengers.

The detached position uses a conservative offset based on vehicle heading and seat side. It is not a terrain-tested safe exit for every vehicle class. Claimed vehicles keep the existing retention policy; this change does not delete player assets or implement repairs.

### Next work, in order

| Priority | Status | Work and required evidence |
| --- | --- | --- |
| Character movement foundation | ✅ | New-sample movement, short-step animation targets, bounded stopping, shortest-angle heading and task/lifecycle reset. |
| Weapon delivery and projectile lifetime | ✅ | Preserve confirmed shots across both client queues, current-aim intents, declared range and static-only unobstructed projectile continuation. |
| Vehicle seat and destroyed-state foundation | ✅ | Preserve driver movement allowance through passenger changes; release occupants and ownership on confirmed destruction. |
| Character actions | ❌ | Moving aim/strafe and upper/lower-body blending; cover, rolling, climbing, swimming, falling/ragdoll and precise gait phase. Verify individual natives, task cancellation and state transitions before exposing them. |
| Combat detail | ❌ | Verified hit components, head/limb rules, armour, bounded lag compensation, ammo/reload ownership and pickups. Define replay-safe damage/equipment transactions instead of trusting a client hit or health field. |
| Vehicle damage | ❌ | Map native collision handles to shared vehicle identity, validate model-specific bounds and hit components, then implement bullet/blast damage, tyres, glass, doors, tank, repair and safe exit selection. Current engine/body damage reports are lease-checked client candidates. |
| Special equipment | ❌ | Moving-vehicle sticky attachments, mounted-weapon permissions, stun state, fuel trails, extinguishing and shared fire. A catalogue entry or visual effect does not implement the interaction. |

The local checks exercise the real Java rules and WebSocket protocol, the JavaScript bridge with native-call mocks, and read-only resource/output protection. Static native decoding identifies the task used by the supported engine. These evidence types are separate from actual two-client rendered animation; this update does not record a new rendered gameplay session.

## 简体中文

启动器 0.2.18 与服务端 0.4.6 修复角色、武器、载具三条核心交互链中的具体缺陷，继续完善现有浏览器同步桥和 Java 共同世界。这不是 FiveM 移植，也不表示所有 GTA 交互已经完成。

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

重生、代次变化、远距离位置纠正和上下车都会重置移动缓存。跳跃、瞄准、换弹及近战有明确优先级，旧走路/站立任务不会立即覆盖它们。这还不是完整上下身动作混合或原生任务树复制。

### 武器：逐层跟踪一发射击

链路为原生射击/扣弹观测 → 工作线程有界队列 → 页面有界队列 → 服务端射速 → 命中/遮挡 → 权威生命 → 远端无伤害表现。

- 不再用没有本次时间戳的 `GET_PED_LAST_WEAPON_IMPACT_COORD` 覆盖瞄准；它可能仍是上一发或上一把枪的落点。改用当前镜头方向与目录射程提交意图。
- 已观察到的扣弹不再因本机重复套用服务端冷却而丢失。延迟扣弹与已采集的射击脉冲去重，换弹过渡不计作额外射击。
- 两级客户端队列各最多八个意图，寿命一秒，清除旧武器/生命输入。页面仅做短间隔传输，服务端继续保留自己的有界队列、武器节奏与全部校验。
- 使用武器声明射程，取消固定 100 米终点；服务端容忍射程边界的毫米级浮点误差。实际伤害仍受地图/流式查询覆盖约束，不代表原生碰撞能看到 1,500 米。
- 修复物理投射物将“仅静态查询无遮挡、无需查询票据”误判为过期的问题，继续执行服务端角色扫掠碰撞。原生查询不完整或超时仍不能当作无遮挡。

受支持 `weapons.meta` 仍有 91 项，另加三个已发布兼容规则和空手别名，共 95 项，包含工具、动物和环境伤害原因；不能称为 95 把完整可玩武器。武器与物理生成目录继续核对真实资源，没有用猜测数值替换。

### 载具：座位、运动与损毁

上车立即将角色确认位姿对齐车辆。乘客上下车不再重置司机累计的移动额度，避免下一份行驶更新被错误拒绝。角色脱离座位时重置自己的移动额度和继承车速。

获准损伤达到引擎 −4,000 或车身 0 时，同一次注册表事务解除全部乘员、停机/清零运动并撤销模拟权。损毁车辆不能再入座或取得新模拟租约。客户端按损毁状态呈现，不重播原生爆炸，不凭空生成乘员伤害。普通受损、尚未摧毁的车辆继续保留乘员。

下车位置采用车朝向和座位侧的保守偏移，尚未对每种车型及地形做安全选点。已认领车辆保留原有保留策略，不因此删除玩家资产，也不提供维修。

### 后续顺序

| 优先范围 | 状态 | 待办与所需证据 |
| --- | --- | --- |
| 角色移动基础 | ✅ | 按新样本移动、小步动画前方目标、有限停步、最短角朝向及动作/代次重置。 |
| 射击送达与投射物生命周期 | ✅ | 两级队列保留确认射击、当前瞄准、声明射程、静态无遮挡投射物继续飞行。 |
| 车辆座位与损毁基础 | ✅ | 乘客变更保留司机移动额度；确认损毁后释放乘员和所有权。 |
| 角色动作 | ❌ | 移动瞄准/侧步及上下身混合，掩体、翻滚、攀爬、游泳、摔倒/布娃娃和精确步态相位；逐个核对 native、取消与状态切换。 |
| 细分战斗 | ❌ | 真实命中部位、头/肢体规则、护甲、有界延迟补偿、弹药/换弹归属及拾取；建立防重复事务，不信任客户端自报命中或生命。 |
| 车辆损伤 | ❌ | 原生碰撞 handle 映射共同车辆身份、验证车型包围盒与部件后，再实现枪弹/爆炸伤害、轮胎、玻璃、车门、油箱、维修及安全下车；现有引擎/车身损伤仍是经租约校验的客户端候选。 |
| 特殊装备 | ❌ | 移动车辆黏弹附着、车载武器权限、电击状态、铺油、灭火和共同火势；目录项或特效不等于交互已完成。 |

本地检查覆盖真实 Java 规则和 WebSocket 协议、替代原生调用的 JavaScript 桥回归，以及资源只读/输出保护。原生命令由静态解码确认；这些证据与双客户端实际渲染不同，本轮未新增实机动画记录。

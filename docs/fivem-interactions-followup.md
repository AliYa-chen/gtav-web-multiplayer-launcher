# Further FiveM references for players, weapons and vehicles

[English](#english) | [简体中文](#简体中文)

## English

Launcher 0.2.19 and server 0.4.7 use the following FiveM source observations to improve character tasks, physical attachments and seats. Further read-only original-engine analysis adds bounded vehicle contact and death-presentation support. The implementation remains in this project's browser bridge and Java server. Current action, precision and equipment extensions are documented in the component release notes.

### Verified reference

All links point to upstream commit [`a74c2ccf0a56546dbb591b4545c643f56acebd3d`](https://github.com/citizenfx/fivem/tree/a74c2ccf0a56546dbb591b4545c643f56acebd3d). The inspected files match these Git blobs:

| File | Git blob |
| --- | --- |
| `SyncTrees_Five.h` | `3325c48e839d791b71967c84f032ca20803ba928` |
| `ServerGameState.cpp` | `23d60da34d671d6271777205efb4d7db05b2d36c` |
| `CloneManager.cpp` | `6a5840d17a66b3be9ff645d3a74e94728a83eaa4` |

The original-engine ABI was separately decoded from the supported `game.wasm`, SHA-256 `11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0`. A FiveM node or a desktop native name alone is insufficient evidence for a browser call. No upstream product code or binary was copied. See [source, protocol and licence boundaries](FiveM参考与浏览器实现边界.md).

### Completed local changes

| Area | FiveM evidence | Previous gap and resulting behavior |
| --- | --- | --- |
| Player movement and tasks | [`SyncTrees_Five.h:2436–2465`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/include/state/SyncTrees_Five.h#L2436-L2465) separates movement group, strafe and ragdoll; [`2604–2641`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/include/state/SyncTrees_Five.h#L2604-L2641) records task activity, priority, depth and sequence. [`CloneManager.cpp:1190–1205`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/gta-net-five/src/CloneManager.cpp#L1190-L1205) distinguishes object instances and [`1242–1259`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/gta-net-five/src/CloneManager.cpp#L1242-L1259) checks whether a clone can be applied. | Remote aiming previously disabled locomotion while accepted coordinates continued to move. The bridge now uses the verified combined movement/aim task. Generation, teleport, recovery and seat changes clear old native tasks and the reload/aim/melee caches; new tasks wait for the exact native seat to be ready or the old native seat to finish releasing. |
| Sticky attachments | [`SyncTrees_Five.h:587–652`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/include/state/SyncTrees_Five.h#L587-L652) describes physical attachment parent identity, local offset, orientation and bone fields. | A charge on a moving character previously stayed at its old world position. Confirmed server capsule contacts now save parent ID, generation and local offset. Parent translation/rotation updates the charge and its obstruction normal before simulation, snapshots and detonation. Deleted/reborn parents and invalid query bounds expire the charge without damage. |
| NPC vehicle exits | [`ServerGameState.cpp:2158–2193`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/src/state/ServerGameState.cpp#L2158-L2193) reconciles old/new seats and clears an old occupant only when its identity matches; [`2064–2081`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/src/state/ServerGameState.cpp#L2064-L2081) clears occupancy during entity removal. | An NPC's native forced exit previously left its server seat occupied and the bridge warped it back. The lease owner first observes the exact confirmed native seat, then submits a bounded exit candidate. The server validates both entity lifetimes, both ownership epochs, the active ownership group and exact occupant before atomically detaching. Driver exit revokes driving ownership; passenger exit preserves it. |

The movement/aim export is function 60670, type 752: `(i32,i64,i64,f32,i32,f32,f32,i32,i32,i32,i32) → void`. Its decoded body creates `CTaskGoToPointAiming` and installs it with `GivePedScriptedTask`. The bridge passes `shoot=false`; accepted bullets still use the existing zero-damage visual relay. Position remains constrained to the server sample. This adds one combined task, without reproducing an entire task tree or precise gait phase.

Sticky parent identity comes from the server's shared-PED capsule or verified vehicle-triangle contact. The three exported models ASEA, BLISTA and POLICE provide 1,512 LOD0 triangles and 15 conservative bounds for unknown primitives. Nearest vehicle contacts obstruct character shots/projectiles; uncertain bounds block without damage or attachment. Vehicle charges follow parent generation, quaternion and local offset, expiring on parent deletion/replacement. Native world hits still lack a verified shared parent mapping; bone/component attachment and all-model coverage remain unfinished. Existing landed events replace the latest position and late-join baseline. See [vehicle geometry and native damage limits](vehicle-damage.md).

Confirmed health-loss edges use original cosmetic torso blood, with revision/life deduplication and cleanup. Player/NPC deaths retain native tasks; dead NPCs remain unfrozen and avoid AI/seat replay across repeated snapshots or ownership changes. Revival rebuilds AI state. The local player's original death-camera command provides shake/depth of field; the complete scripted overhead/pull-away sequence and general shared ragdoll replication remain unfinished. Native damage auditing confirms field defaults and conditional tank/fire processing, without deriving a universal health-to-explosion formula.

NPC exit observations reset across world, generation, native-handle and ownership changes. Initial loading and wrong-seat/shuffle states follow snapshot correction. While a confirmed exit is pending, the client briefly suspends the warp-back correction; bounded retries then return to correction if no server detach arrives. The observation is a lease-checked client candidate, rather than independent server proof of native motion. It cannot enter a seat, eject a player or submit a new transform or damage amount.

### Next useful references

| Priority | Status | Source evidence and work still required |
| --- | --- | --- |
| Combined movement/aim and task reset | ✅ | Verified native combined task and lifecycle cleanup described above. General upper/lower-body blending is outside this scope. |
| Sticky charges on confirmed shared characters | ✅ | Local-offset following, rotation, late-join baseline and invalid-parent expiry. |
| Leased NPC forced-exit reconciliation | ✅ | Established native-seat observation, fenced candidate and atomic seat/driver cleanup. |
| Ammunition, reloads and inventory | ❌ | [`SyncTrees_Five.h:1329–1365`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/include/state/SyncTrees_Five.h#L1329-L1365) carries current weapon, an ammo-presence bit and components; [`ServerGameState.cpp:5441–5482`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/src/state/ServerGameState.cpp#L5441-L5482) parses give/remove weapon events. Implement bounded server equipment transactions, original capacities and verified native ammo reconciliation. Event parsing does not provide a complete authoritative ammo ledger. |
| Hit components and armour | ❌ | [`ServerGameState.cpp:4988–5017`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/src/state/ServerGameState.cpp#L4988-L5017) includes target IDs, hit component and vehicle fields; [`5204`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/src/state/ServerGameState.cpp#L5204) decodes a five-bit component. [`SyncTrees_Five.h:2377–2386`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/include/state/SyncTrees_Five.h#L2377-L2386) synchronizes armour. Verify component-to-geometry mapping and actual absorption before applying head/limb/armour rules. A component number is not automatically a bone hash; an armour state node does not define its formula. |
| Verified vehicle contact and sticky following | ✅ | Three-model geometry scope above; quaternion/local-offset following and uncertain-bound rejection. |
| Native injury/death presentation | ✅ | Original cosmetic blood, player/NPC death-task retention and local camera shake/depth of field. |
| Complete vehicle damage and attachments | ❌ | [`SyncTrees_Five.h:1003–1104`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/include/state/SyncTrees_Five.h#L1003-L1104), `CVehicleHealthDataNode`, separates engine, tank, body and tyre state. Complete all-model/component geometry and native damage/fire/explosion rules. Current engine/body reports remain leased client candidates. Keep passenger occupancy separate from control migration. |
| Complete death sequence and server world | ❌ | Scripted overhead/pull-away camera, general ragdoll replication and the complete server-side game world. |
| Further character actions | ❌ | Cover, roll, climbing, swimming, falling/ragdoll, and gait synchronization each need a verified native, a bounded task lifecycle and shared state. |

### Verification and compatibility

Additional local checks cover real three-model geometry loading, nearest ray/point and quaternion queries, uncertain-bound rejection, moving vehicle sticky lifecycle, health-loss blood deduplication and owner/nonowner NPC death/revival. Full recovered WAT recompilation preserves every standard section, including order and headers; these are static and mock/runtime-code checks rather than rendered gameplay evidence.

Local checks exercise actual Java world/combat code, browser transport validation, both engine bridges with native-call mocks, static ABI/body decoding and launcher adaptation. The checks cover moving aim, stop/release, task transitions, attachment movement/rotation, snapshot-before-broadcast, deletion/respawn, obstruction and boundary expiry, NPC exit ownership/seat fencing, native loading, handle recreation and retry bounds. These checks do not establish two-client rendered animation; no new rendered gameplay session is recorded.

The launcher reads the supported original engine and adds verified exports only to its managed online runtime copy. Updated adaptation was checked against two supported resource paths; offline copies remain byte-identical, old caches are rebuilt, and unsupported versions fail before creating a runtime cache. Vehicle geometry is a separate ignored world-data file; original game inputs and existing world-data hashes remain unchanged. Four owned hooks compile from WAT source, while full local recovery provides 91,111 named functions and 224 multiplayer interfaces with standard-section round-trip checks. It does not recover original C++; see [engine source and extension workflow](online-engine-source.md).

Use launcher 0.2.19 with server 0.4.7 for the complete local changes. Previous clients do not submit the new NPC-exit candidate. The same server update's original damage rules also exceed older clients' rule-value bounds; see [damage compatibility](weapon-damage.md). No installer, release or remote deployment is produced by this local task.

## 简体中文

启动器 0.2.19 与服务端 0.4.7 根据 FiveM 源码完善角色任务、物理附着与座位；进一步只读原引擎增加有限载具接触和死亡表现支持。实现仍位于本项目浏览器桥和 Java 服务端；本版动作、精度和装备扩展见各组件更新说明。

### 已核验的参考

所有上游链接固定到 [`a74c2ccf0a56546dbb591b4545c643f56acebd3d`](https://github.com/citizenfx/fivem/tree/a74c2ccf0a56546dbb591b4545c643f56acebd3d)。实际读取的三个文件均与上方 Git blob 表一致。另对受支持原 `game.wasm` 的函数体和 ABI 做只读解码；FiveM 节点或 PC native 名称本身不足以证明 WASM 调用正确。没有复制上游产品源码或二进制，见[源码、协议与许可边界](FiveM参考与浏览器实现边界.md)。

### 本地已完成

| 类别 | FiveM 对照入口 | 原缺口与改后行为 |
| --- | --- | --- |
| 角色移动与任务 | `SyncTrees_Five.h:2436–2465` 分离移动组、侧步与布娃娃；`:2604–2641` 记录任务活动、优先级、深度和序号。`CloneManager.cpp:1190–1205、1242–1259` 区分对象实例并验证应用条件。链接见上方英文表。 | 远端瞄准原本禁止走路，坐标却仍移动。现在使用已核验的联合移动瞄准任务；代次、远距离纠正、恢复和座位变化清理旧任务及换弹/瞄准/近战缓存，原生准确座位就绪或旧座位释放后再安装新动作。 |
| 黏弹附着 | `SyncTrees_Five.h:587–652` 的物理附着包含父实体、局部偏移、方向与骨骼。 | 命中移动角色的黏弹原本留在旧世界坐标。服务端胶囊确认后保存父实体 ID、代次和局部偏移；模拟、快照、引爆前随父实体平移/旋转，并旋转遮挡法线。父实体删除/重生或查询边界失效时正常过期，不造成伤害。 |
| NPC 离车 | `ServerGameState.cpp:2158–2193` 协调新旧座位，仅清理身份相符的旧乘员；`:2064–2081` 在实体删除时清理占座。 | NPC 原生强制下车后，服务端原本仍保留座位，客户端又把它放回车中。租约所有者先确认 NPC 在原生正确座位，再提交有界离车候选；服务端核对角色/车辆代次与双方所有权 epoch、活动所有权组和准确乘员后原子解除座位。司机退出撤销驾驶权，乘客退出保留驾驶权。 |

联合移动瞄准命令为函数 60670、类型 752，真实 ABI 为 `(i32,i64,i64,f32,i32,f32,f32,i32,i32,i32,i32) → void`；函数体构造 `CTaskGoToPointAiming` 并交给 `GivePedScriptedTask`。调用固定 `shoot=false`，获准子弹仍走现有零伤害视觉转播，坐标仍受服务端样本约束。此次只增加一个联合任务，完整任务树、上下身混合和步态相位尚未实现。

黏弹父实体来自服务端共享 PED 胶囊或已核验车体三角形接触。ASEA、BLISTA、POLICE 三种车型提供 1,512 个 LOD0 三角形及 15 个未知形状保守范围；最近车体接触遮挡角色射击/投射物，未知范围阻断而不授权伤害或附着。车辆黏弹按父代次、四元数和局部偏移跟随，父实体删除/换代时过期。原生世界命中仍缺共享父实体映射，完整骨骼/部件附着和全车型覆盖未完成。原落地事件更新最新位置，晚加入收到当前基线，见[载具几何与原生损伤边界](vehicle-damage.md#简体中文)。

确认扣血后应用原生躯干血迹，按修订/生命去重和清理；玩家/NPC 死亡保留原生任务，重复快照或所有权变化不冻结死亡 NPC，也不重新执行 AI/入座任务，复活重建 AI 状态。本人原生死亡镜头提供抖动/景深，完整脚本俯视/拉远和通用共享布娃娃仍未完成。原生损伤分析核实字段默认值及有条件油箱/火势处理，没有推导出通用生命到爆炸公式。

NPC 座位观测在世界、代次、原生句柄和所有权变化时重置。初次加载以及错座/换座由快照纠正；确认离车等待期间暂缓放回原座，有界重试耗尽后恢复纠正。该候选经过租约校验，但不是服务端独立证明的原生运动；它不能批准入座、踢出玩家或提交新坐标/伤害量。

### 后续最值得借鉴的内容

| 优先范围 | 状态 | 参考与仍需完成的工作 |
| --- | --- | --- |
| 联合移动瞄准与任务重置 | ✅ | 上述受验证 native 及生命周期清理；范围不包含通用上下身混合。 |
| 已确认共享角色上的黏弹 | ✅ | 局部偏移跟随、旋转、晚加入基线与无效父实体过期。 |
| 租约 NPC 强制离车协调 | ✅ | 先确认原生正确座位，再提交受校验候选，原子清理座位/驾驶权。 |
| 弹药、换弹与背包 | ❌ | `SyncTrees_Five.h:1329–1365` 有当前武器、有弹药位及组件；`ServerGameState.cpp:5441–5482` 解析给予/移除武器。需要有界服务端装备事务、原版容量和经过验证的原生弹药核对。仅有事件解析不能形成完整权威弹药账本。 |
| 命中部位与护甲 | ❌ | `ServerGameState.cpp:4988–5017、5204` 有目标、部件/车辆字段及五位部件码；`SyncTrees_Five.h:2377–2386` 同步护甲。先验证部件到几何的映射及吸收规则，再应用头/肢体/护甲计算；不能直接把部件码当骨骼 hash，也不能从状态节点推断公式。 |
| 已核验车体接触与黏弹跟随 | ✅ | 上述三车型范围、四元数/局部偏移跟随及未知范围拒绝。 |
| 原生受伤/死亡表现 | ✅ | 原生血迹、玩家/NPC 死亡任务保留及本人镜头抖动/景深。 |
| 完整车辆损伤与附着 | ❌ | `SyncTrees_Five.h:1003–1104` 的 `CVehicleHealthDataNode` 分开引擎、油箱、车身和轮胎；继续补全车型/部件几何及原生损伤/火势/爆炸规则。当前引擎/车身仍是租约候选，乘客占座与控制权迁移继续分离。 |
| 完整死亡序列与服务端世界 | ❌ | 脚本俯视/拉远镜头、通用布娃娃同步及完整服务端游戏世界。 |
| 更多角色动作 | ❌ | 掩体、翻滚、攀爬、游泳、摔倒/布娃娃及步态，每项都需要真实 native、有界任务生命周期和共享状态。 |

### 验证与兼容

新增本地检查覆盖三车型真实几何加载、最近射线/点/四元数、未知范围拒绝、车辆黏弹生命周期、扣血血迹去重及 owner/nonowner NPC 死亡/复活。完整恢复 WAT 重编译保留全部标准节、顺序及节头；这些是静态及 mock/实际规则代码检查，不是实机画面证据。

本地检查执行实际 Java 世界/战斗代码、页面传输校验、两个带 native mock 的引擎桥、静态 ABI/函数体解码和启动器适配。覆盖移动瞄准、停步/松开、动作切换、黏弹移动/旋转、快照后广播、删除/重生、遮挡及边界过期，以及 NPC 离车的租约/座位校验、加载、句柄重建和重试上限。这些证据不等于双客户端实机动画观察，本轮没有新增实际渲染会话记录。

启动器只读原引擎，仅在自身管理的在线副本增加已验证导出；两份受支持资源路径适配通过，离线逐字节一致，旧缓存重建，不兼容版本在创建缓存前失败。车辆几何单独写入被忽略的世界数据文件，原游戏输入和既有世界数据哈希不变。四份自有钩子现从 WAT 源码编译；完整本地恢复提供 91,111 个具名函数、224 个多人接口及标准节往返检查，不能还原原 C++，见[引擎源码与扩展流程](online-engine-source.md#简体中文)。

完整本地改动使用启动器 0.2.19 配合服务端 0.4.7。旧客户端不提交新 NPC 离车候选；同版服务端原版伤害规则也超过旧客户端规则值上限，见[伤害兼容范围](weapon-damage.md#简体中文)。本次未构建安装包、发布或部署远程服务。

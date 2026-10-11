# Character action replication / 角色动作同步

The launcher samples native character state on its established script owner and presents accepted server state on remote replicas. This layer never authorizes movement, damage, ammunition, equipment, or vehicle seating. It only uses the supported engine whose SHA-256 is `11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0`; the runtime adapter rejects any other input before building its isolated copy. Player game files remain read-only.

启动器在既有脚本执行线程采样原生人物状态，并在远端表现副本上应用服务器已接受的状态。该层不授予移动、伤害、弹药、装备或座位权限；所有原生函数索引及下述内存布局均受完整引擎哈希校验保护，仅写启动器隔离运行副本及其运行内存，不写回玩家资源。

## Protocol and integration / 协议与接入

`actions_v2` retains the original five booleans (`aiming`, `reloading`, `jumping`, `ducking`, `sprinting`) and adds observed special actions: falling, climbing, ladder climbing, vaulting, swimming, underwater swimming, ragdoll, combat roll, cover/cover side/height/aim/entry, and strafing. Current `move_x`/`move_y` are finite values in `[-3,3]`; current XY magnitude `move_blend` is in `[0,3]`. Optional `animation_phases` contains up to 32 entries: native node `kind` 4, 15, or 17, a resident printable ASCII `name` of 1–160 characters, normalized `phase` in `[0,1]`, and optional original playback `rate` in `[-16,16]`, and optional `parameters` for kind 17 only (1–16 finite values, absolute value at most 65,536). `animation_blends` optionally carries up to 16 resident blend nodes: kind 5/6/13/22, exact printable structural `key` (up to 1,024 characters), and 1–8 finite `weights`. Pair nodes 5/6 carry one weight and optional rate in `[-16,16]`; ordinary blends 5/13 restrict weights to `[0,1]`, additive blends 6/22 to `[-16,16]`. Older peers receive the five-field form. Client and server reject unknown fields and invalid values. A replicated action flag does not bypass position, ownership, generation, health, or interaction validation.

`ladder` optionally identifies an observed resident ladder using exactly six fields: original `model` hash (`uint32`), 12-value `geometry` matrix (first nine axis components bounded by 2; final three translation components bounded by 16,000), `effect` index 0–65,535, ladder `type` 0–2, native `state` 0–15, and a three-value `target` bounded by 16,000. No native handle, pointer, or guessed hash is transmitted. Client and server validate this descriptor before presentation.

可选 `ladder` 描述原生梯子的模型、实际实体变换、2D effect 索引、梯子类别、状态和挂接目标；不传递指针或本地句柄。接收端必须匹配同一模型、实体变换和 effect，才会修正当前已挂接的梯子任务。

`createCharacterActionBridge({ex,memory})` exposes:

- `sample(ped, aiming)` reads native actions and blend values.
- `apply(replica, state, {now,poseReady,animating})` handles special full-body tasks and reports whether they own the pose.
- `layeredReloadSupported` checks the original native exports required for an independent upper-body reload.
- `applyReload(replica,state,{poseReady,animating,readyWeapon})` installs the upper-body reload after ordinary movement tasks. A missing/unready local task tree postpones installation.
- `applyPhases(replica,state)` matches currently resident, uniquely named native animation/clip/parameterized-motion nodes and applies phase/rate/PM inputs and matching blend weights after the frame's task updates.
- `reset(replica)` clears presentation bookkeeping after an external full task clear, entity replacement, or life transition. It does not delete the engine-owned task tree itself.

动作扩展兼容旧五字段协议；客户端和服务器共同校验布尔值、有限数范围及未知字段。主桥在普通移动任务之后应用上身换弹，让下身继续原生步态。特殊动作在死亡、附着/乘车、未完成坐姿切换或另一原生动作占用期间受门控。死亡任务不被站立任务覆盖。

## Native evidence / 原生依据

All indices below refer to the supported original engine, not an external desktop native database. The recovered WAT is local analysis material and is not shipped as original source.

| Behavior | Original function / layout | Applied behavior |
| --- | --- | --- |
| Current move blend | 57666, `(i32,i64,i64)->i32` | Writes two separate `f32` outputs; they are not a `scrVector`. |
| Movement speed | 57666 / 60724 / 60725 | Use current XY magnitude for forward/reverse/strafe speed. The desired getter only returns Y; its absolute value is a fallback. Pass magnitude to the original movement task. |
| Ladder state | 41395 / 60645 | Original detection checks active task type 1 or 47. |
| Combat roll | 70057 / 70056 / 63902 | `Copy()` creates a fresh 336-byte type-3 task; its source parameter is unused. Angle at 320 uses `atan2(-move_x,move_y)`. |
| Cover | 60747 / 60746 | Original geometry lookup with forced facing side; heading is radians. Height remains selected by native cover geometry. |
| Cover aiming | 19294 / 66793 / 66881 / 66888 | Update the resident native target, wait for original weapon clips, and request native aim-intro/aim-outro states. Flag 8192 selects original aim-only controller 1. |
| Attached ladder progress | 69806 / 69804 / 69794 / 69795 | Sample the native ladder identity and target; reconcile idle/up/down/slide through original task state and input after exact local geometry matching. |
| Swimming | 60810 / 70035 / 70040 / 70041 | Original motion-state hashes: swimming `-776007225`, diving idle `1212730861`, diving swim `-1855028596`. |
| Ragdoll | 57461 | Original relaxed ragdoll task, refreshed while the accepted state remains active. |
| Upper-body reload | 77043 / 29870 / 76901 | Native type-301 task inserted in the secondary task tree; flags 4 select `SetSecondaryTaskNetwork`, flags 12 select its cover filter. |
| Reload cleanup | 77041 / 60659 | Before handoff, destroy only the unassigned native allocation. After handoff, clear only the matching locally created secondary task. |
| Animation phase/rate | 18266 / 18267 / 18272 / 18273 | Native type-4 node getters/setters; phase divides player time by original duration. |
| Clip phase/rate | 18298 / 18299 / 18305 / 18306 | Native type-15 node getters/setters; uses original clip player duration, clamping and blocked-time handling. |
| Parameterized gait phase/rate | 18372 / 18374 / 18378 / 18380 | Native type-17 player virtual phase getter/setter and original playback rate. |
| Parameterized gait blend input | 17617 / 18381 / 18375 | Original dimension query and per-dimension getter/setter; the receiving motion must have the exact same dimension count. Native SetParameter preserves its original limits and blending. |
| Pair and N-way blending | 17917 / 17905 / 17964 / 17966 / 5539 | Native ordinary/additive pair and per-input N-way weight setters; resident frame-filter names identify compatible layers. Pair blend rate is the verified local field `+100`. |
| Armour | 57222 / 57166 | Native armour presentation reads/writes; authoritative value comes from server combat state. |
| Shared ammo pool | 62947 | `SetPedAmmoByType` updates the inventory pool without refilling the selected clip. `SetPedAmmo` 62913 does refill it and is unsuitable for clip-preserving reconciliation. |

The reload factory copies only controller at offset 328 and flags at 388 from a launcher-owned 400-byte template. Native code allocates and constructs the full task using its own pool. The bridge allocates 512 bytes for its scratch data and checks the entire range before writing. The local ped address is resolved from its actual native handle and checked as a ped; no network value is interpreted as a pointer. Intelligence comes from ped offset 4320; the secondary tree is intelligence offset 4040, guarded by tree count at 4064. Installation waits while the native tree is processing. `AddTaskSecondary` has optimized ABI `(i64,i64)->void`, despite its demangled C++ name retaining an integer parameter.

A reload starts once per accepted action edge. Native completion does not restart it while an older snapshot still contains `reloading:true`. Any explicit full-task clear must call `reset()` so the current accepted state can be re-applied. The original `TaskReloadWeapon` ignores its boolean parameter and constructs controller 4 / flags 0; no undocumented force flag is added. Its native FSM enters reload animation even when the presentation replica has a full cosmetic clip; single-round reload loops are clamped to at least one.

翻滚与换弹均由原生任务池创建完整对象。交接前失败只释放尚未交给引擎的对象；交接后所有权属于引擎，即使原生调用异常也不由 JavaScript 重复释放。只读的地址解析限定当前本地人物句柄与经完整版本校验的布局，网络消息不能携带可解引用地址。

The phase sampler follows the original `fwMoveDumpNetwork` (4260) root: local ped `+80`, drawable `+64`, animation director move-component slots, component `+32`, move `+504`, motion tree root `+728`. Type-4 animation identity comes from the resident animation's name (`+88` asset, name `+32`); type-15 clip identity comes from its resident clip (`+64` asset, name `+24`). Type-17 parameterized gait nodes resolve their resident motion through player `+64`, motion data `+16`, and nonempty name `+24`/count `+32`, following the original `crmtNodePm::Dump` (17999). Traversal is bounded to 256 nodes and rejects invalid pointers and cycles. No node address is serialized. Duplicate `(kind,name)` pairs anywhere in the local tree are excluded, so similarly named upper/lower layers are never guessed. Parameterized gait input uses its resident motion's original dimension count and native setter, whose original `SetParameter` clamps to the motion's own minimum/maximum limits. A same-name node with a different dimension count is rejected. Incoming names only match existing nodes; they do not request assets or execute arbitrary tasks. Repeated snapshots cannot rewind the animation every render, and unmatched nodes expire after 500 ms rather than affecting a future unrelated task.

Blend identities contain the exact nested node kinds, ordered children, resident leaf names, frame-filter name and inversion flag, plus each N-way input filter. They never use a hash that could collide or a serialized native address. Equal structural keys in multiple local layers are all excluded. Unknown/unnamed descendants, custom pair weight modifiers, mismatched native child counts, and structures over the size/depth limit are skipped. Pair weights/rates use original fields `+96/+100`, filter `+80`, and modifier `+104`; N-way weights use the native checked-index getter/setter, count `+204`, common filter `+192`, and per-input filter `+72+16*i`. The same once-per-snapshot and 500 ms expiry rules apply. This synchronizes compatible existing blend subtrees; it does not manufacture missing motion networks.

相位与播放速率来自原生动画树，使用原生 getter/setter，支持真实循环相位回绕、暂停和倒放速率。节点地址仅在本地解析；网络仅传名称、类型和有限数值。树遍历有数量、越界及循环保护，同名多节点全部略过，旧快照不在每帧反复倒播，也不会无限等待后影响将来的其他任务。

## Cover and ladder transitions / 掩体与梯子过渡

Cover aiming resolves the original active primary task chain, bounded to 64 entries, and requires a type-312 `CTaskInCover` under a type-290 `CTaskCover` belonging to the same replica. It rejects processing task trees, missing native cover geometry, and the alternate AI combat-controller branch. The accepted aim target updates the parent's `CAITarget` at offset 544 using original setter 19294; the current type-293 aim-only gun task's independent target at 352 is also refreshed. Parent flag 8192 selects controller 1 in original `CreateFireTask` 66888. Native state 6 builds the aim-intro network and its children, state 7 maintains aiming, and state 8 performs the outro. The implementation keeps the native stay-in-cover flag and never changes player/clone identity or creates an autonomous firing task. Reloading requests the outro so the independent reload layer can operate. Original streaming, geometry and weapon compatibility still govern whether the pose can start.

Ladder sampling follows the same checked primary task chain to native task type 1 (672 bytes). Original `CreateQueriableState` 69806 establishes the geometry pointer at 592, effect at 616, type at 600, and target at 480. Geometry identity uses its original model hash and full entity matrix, not a lossy positional hash. Receiving replicas require model/effect/type equality, axis difference at most 0.0001, and translation difference at most 0.02 m. Correction only applies when both tasks are already in steady native states 7/8/9/12 (idle/up/down/slide), and the target is within 2 m of the receiver's own native target. The corresponding original task input at 608 is 0/1/2/4. State changes use original setter 69804; mounting and dismounting are never forced into a later state. Matching snapshots are applied once, with at most 500 ms allowed for the receiver's task to become ready. Resident clip phase correction operates independently through the animation tree described above.

掩体瞄准通过原生任务状态 6/7/8 完成探身、瞄准及收回；只使用瞄准控制器，目标变化会更新已有任务的目标副本。梯子修正要求本地与远端已挂接同一实体、模型及 effect，随后同步原生停留、上爬、下爬和滑下状态；目标差异超过两米、挂接尚未完成、缺少几何或快照过期均不会强行应用。两条路径均经过任务树归属、边界、循环及执行中状态检查。

## Coverage and remaining work / 覆盖范围与未完成部分

Implemented: native action sampling and validated transport, special-task transitions, direction-aware combat roll, ladder/climb requests, exact resident ladder matching with bounded steady-state progress correction, cover side and native aim-intro/aim-outro transitions, swimming/diving motion state, active ragdoll presentation, an independent native upper-body reload layer, and unique resident animation/clip/parameterized gait phase, playback-rate, and parameterized gait-input correction, and exact-structure matched ordinary/additive pair/N-way blend weights. Ordinary movement/aiming continues through original native tasks with sampled blend speed. Mock-native regressions cover task edges, gating, native argument layout, scratch boundaries, ownership cleanup, cover target/controller transitions, and ladder identity/target/expiry rejection; ABI checks cover the supported original binary. These are static and local harness checks, not a claim of in-game verification.

Full upper/lower-body and gait synchronization is still incomplete. Phase/rate correction now covers uniquely named resident animation, clip, and parameterized gait nodes; it does not create missing networks or disambiguate duplicated layers. Missing or incompatible blend subtrees, custom weight modifiers, full motion-network transitions, forced cover-height/lean reconstruction, missing-ladder reconstruction, exact climb/vault attachment and mounting/dismounting progress are not implemented by this module. Individual ragdoll bone transforms use the separate ragdoll-pose bridge, rather than the task/phase layer described here. Native geometry can choose a different cover or climb result if local streamed geometry differs. `GetTaskMoveNetworkSignal*` only queries task type 135 and cannot be used as a general player locomotion-phase reader. Do not mark the complete P0 character-action scope finished based only on these bounded additions.

已实现原生采样、校验传输、特殊任务切换、带方向翻滚、梯子/攀爬请求、同一原生梯子的受限进度修正、掩体侧向与原生瞄准/收回过渡、游泳/潜水状态、布娃娃表现及独立上身换弹，并对当前树中名称唯一的动画/片段/参数化步态节点同步真实相位、播放速率及经原生维度检查的步态输入，并按精确子树与骨骼过滤器匹配同步普通/叠加、双路/多路混合权重。完整上下身与步态同步仍未完成：缺失网络重建、重名层匹配、缺失/不兼容混合子树及完整动作网络过渡、强制掩体高度/探身重建、缺失梯子重建，以及完整攀爬/翻越附着和梯子挂接/离开进度尚未实现；逐骨骼布娃娃姿态由独立 ragdoll-pose 桥处理。静态 ABI 核验和本地回归通过不等于实际游戏表现已经验证，P0 的完整范围仍应保持未完成标记。

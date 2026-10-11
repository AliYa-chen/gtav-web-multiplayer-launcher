# Vehicle contacts, damage and native destruction

## English

Local server 0.4.7 adds verified vehicle contact geometry and moving-vehicle sticky attachments. It does **not** yet reproduce the engine's complete vehicle damage, fuel/fire or explosion rules. Engine/body health reports remain fenced candidates from the current simulation owner. Launcher 0.2.19 adds native cosmetic blood, native player/NPC death-task preservation and the local player's original death-camera shake/depth-of-field effect; the complete scripted overhead/pull-away camera sequence is not established.

### Implemented contact scope

[`export_vehicle_collision.py`](../tools/export_vehicle_collision.py) reads the supported engine and `vehicles.rpf` without changing them. It follows the audited fragment → physics LOD0 → pristine archetype → bound references, and writes separate ignored `server/world-data/vehicle-models.json`. [`VehicleCollision.java`](../server/src/main/java/offline/multiplayer/VehicleCollision.java) loads that data for server queries.

| Model | Verified LOD0 triangles | Bounds whose exact primitive geometry is still unknown |
| --- | ---: | ---: |
| ASEA | 598 | 5 |
| BLISTA | 378 | 5 |
| POLICE | 536 | 5 |

The **1,512 triangles** support nearest vehicle/PED shot obstruction, projectile contact and generation-fenced sticky attachment with vehicle quaternion/local-offset following. An unparsed primitive's conservative bound blocks uncertain shots or attachments; it is never treated as a verified damage surface. Unknown models do not acquire invented geometry. All three model records have incomplete coverage. Material flags, component hit regions, wheel/disc geometry, deformation and the whole vehicle catalogue remain unfinished.

[`CombatWorld.java`](../server/src/main/java/offline/multiplayer/CombatWorld.java) keeps vehicle obstruction distinct from PED health damage. A verified car surface does not supply the missing engine/body/tank damage formula. An uncertain car surface cannot authorize damage to a character behind it. Shared vehicle sticky charges follow the confirmed parent pose; deleting or replacing that parent expires the charge. The data loader and world status expose geometry coverage and the conservative unknown-bound policy.

### Original metadata and native evidence

[`vehicle_damage_metadata.py`](../tools/vehicle_damage_metadata.py) records **298 vehicle definitions**, **248 handling definitions** and **91 weapon definitions** in the resource-free [`VehicleDamageCatalog.java`](../server/src/main/java/offline/multiplayer/VehicleDamageCatalog.java). It preserves missing values and unresolved handling IDs; `POLICE` has no matching handling record in this snapshot and does not inherit another model's rules. Fuel capacity and force fields are not used as health-damage amounts or explosion thresholds.

The supported engine's read-only static audit, cross-checked against recovered WAT, establishes these bounded facts:

| Fact | Verified native location or context |
| --- | --- |
| Weapon `VehicleDamageModifier` | `CWeaponInfo` offset 212, actual parser default 1.0. |
| Weapon `LightlyArmouredDamageModifier` | Offset 208, actual parser default 0.75. |
| `EXPLOSIVE` damage type | Enum value 5. |
| Scale-to-max-vehicle-health flag | Weapon bit 102; `CVehicleDamage::ApplyDamage` checks `weaponInfo+2260 & 64`, then uses vehicle max health × handling field at 360 before the weapon vehicle multiplier. This is a subexpression, not the complete damage formula. |
| Handling fields | `fWeaponDamageMult` at 244; `fPetrolTankVolume` at 256; `fPetrolConsumptionRate` at 264; `fWeaponDamageScaledToVehHealthMult` at 360. |
| Engine fire processing | In `CVehicleDamage::Process`, negative engine health decays toward −4000 when the engine-fire disable flag is clear. That branch does not directly establish a universal explosion trigger. |
| Tank fire processing | Native tank fire uses negative sentinels, remaining fuel, elapsed time and additional physics/model conditions. `−999.9000244140625` remains in the processing window; the exploded sentinel is exactly −1000. They are not interchangeable. |
| Native explosion execution | `CAutomobile::BlowUpCar` has presentation/network-clone conditions before `AddExplosion`; a health comparison alone is insufficient. |

The existing registry's engine −4000/body 0 condition is the project's terminal vehicle-state policy: release occupants, stop motion and revoke the lease. It must not be described as the game's universal explosion rule. The client does not replay a native explosion, preserving the [explosive-rendering stability boundary](explosive-rendering.md).

FiveM's separate engine/tank/body/tyre state in [`CVehicleHealthDataNode`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/include/state/SyncTrees_Five.h#L1003-L1122) supports keeping those components distinct. Its state parser does not provide a complete damage or explosion formula. No FiveM code or binary is incorporated.

### Checks and remaining work

Local checks cover real geometry loading, ray/nearest-point/quaternion queries, character-versus-car obstruction, uncertain-bound rejection, moving vehicle sticky attachments and parent lifecycle. Native body hashes and full WAT standard-section round-trip checks corroborate the static audit. The bridge checks cover authoritative health edges, cosmetic blood deduplication, native death/ragdoll task retention, revival and NPC ownership/seat transitions. Original resource hashes remain unchanged; no new rendered gameplay session is claimed.

✅ Verified contact and moving-vehicle sticky scope for the three exported models. ✅ Cosmetic blood and bounded native death effects. ❌ Complete component damage, tank/fire propagation, exact explosion timing, all vehicle models, scripted death-camera sequence and the complete server-side game world.

## 简体中文

本地服务端 0.4.7 增加经过核验的载具接触几何与移动车辆黏弹附着，**尚未完整复现原引擎的车辆损伤、油箱/燃烧及爆炸规则**。引擎/车身生命上报仍是当前模拟者提交、经过租约校验的候选。启动器 0.2.19 增加原生血迹、玩家/NPC 死亡任务保留及本人原版死亡镜头抖动/景深；完整脚本俯视/拉远镜头序列仍未确认。

### 已实现的接触范围

[`export_vehicle_collision.py`](../tools/export_vehicle_collision.py) 只读受支持原引擎及 `vehicles.rpf`，按已核验的碎片 → 物理 LOD0 → 原始 archetype → bound 路径提取，独立写入被忽略的 `server/world-data/vehicle-models.json`；[`VehicleCollision.java`](../server/src/main/java/offline/multiplayer/VehicleCollision.java) 用于服务端查询。

| 车型 | 已核验 LOD0 三角形 | 尚未解析精确形状的 primitive |
| --- | ---: | ---: |
| ASEA | 598 | 5 |
| BLISTA | 378 | 5 |
| POLICE | 536 | 5 |

共 **1,512 个三角形**支持角色/车辆最近射线遮挡、投射物接触，以及按车辆四元数/局部偏移跟随的代次校验黏弹。未解析 primitive 的保守范围阻断不确定射击/附着，不被当作真实受伤表面；未知车型不猜测几何。三份车型记录都明确覆盖不完整，材质标志、部件命中区、轮胎/圆盘、变形及全车型仍未完成。

[`CombatWorld.java`](../server/src/main/java/offline/multiplayer/CombatWorld.java) 将车辆遮挡与角色扣血分开；真实车身接触仍不能替代尚缺的引擎/车身/油箱损伤公式。不确定表面不能授权伤害车后角色。车辆黏弹跟随已确认父实体姿态，父实体删除或换代时过期；加载器与世界状态公开几何覆盖和未知范围保守策略。

### 原始元数据与原生证据

[`vehicle_damage_metadata.py`](../tools/vehicle_damage_metadata.py) 将 **298 项车辆、248 项 handling、91 项武器定义**记录到不含游戏资源的 [`VehicleDamageCatalog.java`](../server/src/main/java/offline/multiplayer/VehicleDamageCatalog.java)。缺值和未解析 handling ID 明确保留；当前快照没有 `POLICE` 对应 handling，不能套用其他车型。燃油容量、受力参数都不是扣血量或爆炸阈值。

只读原引擎并以恢复 WAT 对照后，确认以下有限事实：

| 事实 | 已核验原生位置或上下文 |
| --- | --- |
| 武器 `VehicleDamageModifier` | `CWeaponInfo` offset 212，真实解析器默认 1.0。 |
| `LightlyArmouredDamageModifier` | offset 208，真实默认 0.75。 |
| 爆炸伤害类型 | `EXPLOSIVE=5`。 |
| 按车辆最大生命缩放标志 | 武器 bit 102；`CVehicleDamage::ApplyDamage` 检查 `weaponInfo+2260 &64`，先取车辆最大生命 × handling+360，再乘武器伤车倍率。这只是完整路径中的子式。 |
| Handling 字段 | `fWeaponDamageMult` offset 244；油箱容量 256；油耗 264；按车辆生命缩放倍率 360。 |
| 引擎燃烧处理 | `CVehicleDamage::Process` 在引擎生命为负且未禁用引擎火时继续衰减，下限 −4000；这条分支不能证明通用爆炸阈值。 |
| 油箱燃烧处理 | 涉及负值哨兵、剩余燃油、经过时间及额外物理/车型条件；`−999.9000244140625` 仍在处理区间，已爆哨兵才是 −1000，二者不能互换。 |
| 原生爆炸执行 | `CAutomobile::BlowUpCar` 在 `AddExplosion` 前还检查表现/网络 clone 条件，单次生命比较不够。 |

注册表现有的“引擎 −4000/车身 0”是本项目终止车辆状态策略：释放乘员、停止运动、撤销模拟权，不能称为原游戏通用爆炸规则。客户端不重放原生爆炸，保留[爆炸表现稳定边界](explosive-rendering.md)。

FiveM [`CVehicleHealthDataNode`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/include/state/SyncTrees_Five.h#L1003-L1122) 分开读取引擎、油箱、车身和轮胎，支持将组件分开处理；其状态解析器不提供完整损伤/爆炸公式。产品未引入 FiveM 源码或二进制。

### 检查与尚缺范围

本地检查覆盖真实几何加载、射线/最近点/四元数、角色与车体遮挡、未知范围阻断、移动车辆黏弹及父实体生命周期。原生函数体哈希与完整 WAT 标准节往返对照支持静态分析；桥检查覆盖权威生命变化、血迹去重、死亡/ragdoll 任务保留、复活以及 NPC 所有权/座位变化。原资源哈希未变，本轮未新增实机渲染记录。

✅ 三份已导出车型的真实接触与移动车辆黏弹范围。✅ 原生血迹及有限死亡效果。❌ 完整部件损伤、油箱/火势传播、准确爆炸时序、全车型、完整脚本死亡镜头及完整服务端游戏世界。

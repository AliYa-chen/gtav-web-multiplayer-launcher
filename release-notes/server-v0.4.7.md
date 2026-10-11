## English

**Category: Server · Version: 0.4.7-world-experimental**

### Changes

- Replace custom damage tables with 91 supported original weapon definitions plus the unarmed loading alias. Bullets retain per-pellet amounts, player/NPC modifiers and range falloff; basic melee follows the original action/reaction metadata; 36 validated explosion records supply centre/edge damage, radius and network modifiers. Unknown weapons fail explicitly.
- Load separately generated original PED geometry for ten supported models: 21 rigid parts, with capsules/boxes placed by validated native bone observations. Confirm the nearest actual component before head/limb damage and original ordinary-armour absorption. Resolve protective head-prop flags from original base/DLC variation collections, count confirmed bullet impacts and remove a broken prop without allowing the same life to re-equip its protection.
- Add bounded 250 ms combat history with generation, ownership and attachment fences. Rewound targets retain current obstruction checks; queued shots consume ammunition only on actual execution. Invalid pose submissions preserve the previously accepted authoritative state.
- Own weapon possession, shared ammunition pools, magazines, reload tokens and pickups on the server. Default original clip durations provide conservative reload completion gates. Five spawn-area supplies use original rewards, one-metre proximity and 60-second regeneration. Inventory state is private; stale/replayed or forged quantity requests are rejected.
- Restore original continuous tear-gas/BZ exposure using source coefficients, native radius growth/lifetime and elapsed server time, with fractional health retained between updates and geometric obstruction checks. Persistent burning remains deferred; prepared `Burning`/`FireCatalog` modules are not called by combat.
- Load ASEA, BLISTA and POLICE contact geometry: 1,512 verified triangles and 15 conservative unknown bounds. Unknown bounds obstruct without granting damage or attachment. Follow confirmed character/vehicle sticky charges through movement, rotation and lifecycle changes.
- Add fenced NPC exit candidates with active actor/vehicle leases, both generations and ownership epochs, monotonic input and exact occupancy. Driver exits revoke the vehicle lease; passenger exits preserve it.
- Record 298 vehicle, 248 handling and 91 weapon definitions while preserving unresolved values. Native engine/body health reports remain lease-checked candidates; complete all-model damage, tyres/glass/doors, tank/fire propagation and native destruction timing remain deferred.

### Compatibility and validation

Requires launcher 0.2.19 with `world_v2`, `actions_v2`, `equipment_v1` and `ped_pose`. Older clients are rejected before entry. A valid independently generated `world-data/ped-collision.json` is required for joining; absence returns `server_geometry_unavailable`. Vehicle contact data is `world-data/vehicle-models.json`. Exporters pin supported input hashes, use guarded atomic outputs and never write back to game resources. Derived geometry is excluded from Git and release packages; ordinary JAR updates preserve existing world data.

Java 17 compilation and local geometry, head/limb/armour, helmet, history, equipment, gas, lifecycle, output-isolation and real WebSocket integration checks cover the implemented paths. No rendered gameplay observation establishes complete native equivalence. Character-stat branches, full melee phases, persistent burning and complete native explosion/vehicle physics remain in the [remaining P0 plan](../docs/p0-next-release.md). See [combat precision](../docs/combat-precision.md), [equipment](../docs/equipment-authority.md), [damage sources](../docs/weapon-damage.md) and [deferred fire](../docs/fire-authority.md).

## 简体中文

**分类：服务端 · 版本：0.4.7-world-experimental**

### 更新内容

- 用受支持原版的 91 项武器定义及空手加载别名替换自定义伤害表。枪弹保留逐颗伤害、玩家/NPC 系数和距离衰减；普通近战追溯原动作/伤害反应；36 项经过验证的爆炸记录提供中心/边缘伤害、半径和网络系数，未知武器明确失败。
- 加载十种受支持角色的独立原版碰撞几何：21 个刚性部位，以通过校验的原生骨矩阵定位胶囊/盒体。确认最近实际部位后应用头/肢体规则和原普通护甲吸收。按原基础/DLC 变体集合解析头部道具保护标志，只对确认子弹命中计数；损坏后移除对应道具，阻止同一生命重新装备来恢复保护。
- 增加最多 250 毫秒的战斗历史，并校验代次、所有权和挂接。回溯目标仍检查当前遮挡；排队射击仅在真正执行时扣弹。无效姿态上报保留此前已接受的权威状态。
- 服务端持有武器、共享弹药池、弹匣、换弹令牌及拾取事务；原默认装填片段时长提供保守完成门槛。出生区五个补给点使用原奖励、一米距离和 60 秒再生。库存仅发本人，过期/重放和自报数量请求明确拒绝。
- 按原系数、半径增长/寿命与实际服务端经过时间恢复催泪瓦斯/BZ 持续曝光，跨 tick 保留小数生命并校验几何遮挡。持续燃烧留到后续版本，已准备的 `Burning`/`FireCatalog` 计算模块尚未被战斗调用。
- 加载 ASEA、BLISTA、POLICE 的 1,512 个真实接触三角形和 15 个未知形状保守范围；未知范围只阻断，不授权伤害或附着。已确认角色/车体黏弹随移动、旋转和生命周期变化更新。
- 增加 NPC 离车候选，检查角色/车辆活动租约、双方代次与所有权 epoch、单调序号和准确占座。司机退出撤销车辆租约，乘客退出保留驾驶权。
- 记录 298 项车辆、248 项 handling 和 91 项武器原始定义并保留缺值。引擎/车身生命上报仍为经租约校验候选；完整车型损伤、轮胎/玻璃/车门、油箱/火势传播和原生损毁时序留待后续。

### 兼容与验证

需要启动器 0.2.19 及 `world_v2`、`actions_v2`、`equipment_v1`、`ped_pose` 能力，旧客户端加入前明确拒绝。加入战局还需要独立生成且有效的 `world-data/ped-collision.json`，缺失返回 `server_geometry_unavailable`；车体接触数据为 `world-data/vehicle-models.json`。导出工具固定受支持输入哈希、保护原子输出，不写回游戏资源。派生几何不提交 Git、不进入发布包；常规 JAR 更新保留既有世界数据。

Java 17 编译，以及本地几何、头/肢体/护甲、头盔、历史、装备、毒气、生命周期、输出隔离和真实 WebSocket 集成检查覆盖已实现路径，不以此宣称完整原生实机一致性。角色属性、完整近战相位、持续燃烧及完整原生爆炸/载具物理仍列于[剩余 P0 计划](../docs/p0-next-release.md#简体中文)。见[精细战斗](../docs/combat-precision.md#简体中文)、[装备](../docs/equipment-authority.md#简体中文)、[伤害来源](../docs/weapon-damage.md#简体中文)及[后续火焰](../docs/fire-authority.md#简体中文)。

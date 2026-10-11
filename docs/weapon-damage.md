# Original weapon damage metadata

[English](#english) | [简体中文](#简体中文)

## English

Server 0.4.7 replaces custom damage tables with the original metadata from the supported resource version. All active server weapon damage amounts now have an original source; a missing definition receives no invented fallback. The catalogue has 91 original entries plus one unarmed loading alias. SNSPISTOL, COMPACTRIFLE and MARKSMANRIFLE were removed because this resource has no definition for them; unknown hashes return `unsupported_weapon`.

| Path | Original source and server use |
| --- | --- |
| Bullets | `weapons.meta`: `Damage` per pellet, `BulletsInBatch`, player/NPC network modifiers and distance-falloff parameters. Only pellets intersecting the validated original rigid-part geometry contribute. |
| Direct projectiles | Referenced ammo `Damage`; original weapon modifiers and range falloff. `DONTCARE` does not invent an explosion. |
| Basic melee | `weaponanimations.meta` → enabled `definitions.meta` action → `results.meta` standard attack → `damages.meta` reaction. Forty fixed ordinary attacks resolve; unsupported actions are not assigned a guessed amount. |
| Discrete blasts | Ammo explosion tag → `explosion.ymt`: centre/edge damage, end radius and player/NPC modifiers. The server interpolates centre to edge over its nearest original rigid-part contact distance and still validates obstruction. This geometric calculation is not a reconstruction of the complete native explosion runtime. |

| Original base parameter | Value |
| --- | ---: |
| Pistol | 26 per bullet |
| Combat MG / Minigun | 32 / 30 per bullet |
| Heavy sniper | 216 per bullet; player modifier 1.39 |
| Pump / Sawed-off shotgun | 29 × 8 / 40 × 8 pellets |
| Ordinary heavy punch / knife / bat | 20 / 75 / 75 |
| Grenade / grenade launcher / sticky bomb | 500 centre, 75 edge, 5 m |
| RPG / plane rocket | 500 centre, 50 edge, 5 m |
| Tank shell | 3000 centre, 300 edge, 5 m |
| Molotov impact | 30 centre, 4 edge, 3 m |

Those blast records have player modifier 2 and NPC modifier 1. Final health loss is capped to remaining health; the rules' base amount is not capped to 200. NPC firing uses the same confirmed weapon values rather than the old fixed 10 points. Its existing 1,500 ms report cooldown remains a simulation constraint.

The 36-record PSO explosion parser pins the supported SHA-256 and verifies the on-file 120-byte schema, mapping, pointers and fields. It rejects incompatible input before publication. Generated Java files record source hashes; the XML/PSO inputs stay read-only, and outputs use guarded independent temporary files and atomic replacement, including external-source JSON reports.

### Unfinished scope and compatibility

Continuous smoke/BZ uses the original fractional coefficients, native radius growth/lifetime and elapsed-time arithmetic, with fractional health retained between server ticks. Original 21-part bone observations now determine hit components; ordinary head/limb, armour and head-prop protection branches are implemented. See [combat precision](combat-precision.md) and [equipment authority](equipment-authority.md). Persistent burning, character stats/special ammunition, complete melee phases, vehicle frag damage and native explosion branching remain [deferred](p0-next-release.md). Prepared fire helpers are not called by combat.

Launcher 0.2.19 is required for the complete 0.4.7 rules because original amounts can exceed the old client's 200-point validation limit. Joining additionally requires the new action/equipment/PED-pose capabilities and independently generated valid PED geometry; older clients fail before entry. Damage remains server-owned. The launcher removes successful hit/damage/kill popups for players and NPCs, including melee-received notifications; native combat presentation and health updates continue. Connection, actionable errors, local death and respawn notices remain.

Local checks cover source consistency, original damage/modifiers, bilateral health, projectile collision, repeated live-target splash and respawn, queue/lifecycle fencing, WebSocket events, popup removal and resource/output isolation. No new rendered live-engine gameplay capture establishes complete native equivalence. Release notes describe the final component scope and compatibility.

## 简体中文

服务端 0.4.7 用受支持资源版本的原始元数据替换自定义伤害表。当前执行的服务端武器伤害量均有原版来源；缺失定义不再猜值兜底。目录为 91 项原始定义加一个空手加载别名。SNSPISTOL、COMPACTRIFLE、MARKSMANRIFLE 因本资源没有定义而移除，未知哈希明确返回 `unsupported_weapon`。

枪弹取 `weapons.meta` 的每颗 `Damage`、弹数、玩家/NPC 网络系数和距离衰减，只累计实际命中的弹丸。直接投射物取所引用弹药的 `Damage`；`DONTCARE` 不生成虚构爆炸。普通近战沿 `weaponanimations.meta` → `definitions.meta` 启用动作 → `results.meta` 标准攻击 → `damages.meta` 伤害反应解析，当前 40 种固定普通攻击有来源，未表示的动作不猜伤害。

单次爆炸沿弹药的类型标签读取 `explosion.ymt`，使用中心/边缘伤害、半径和玩家/NPC 系数；仍在最近原刚性部位接触距离上做中心至边缘插值并校验遮挡，尚未重建完整原生爆炸运行时。手枪基础 26，战斗机枪 32，加特林 30，重狙 216（玩家系数 1.39）；泵动/短管霰弹分别为每颗 29/40、每次八颗。普通重拳 20，刀和棒球棍 75。榴弹/榴弹枪/黏弹为中心 500、边缘 75、半径 5 米；RPG/飞机火箭为 500/50/5 米，坦克炮为 3000/300/5 米，燃烧瓶初次爆点为 30/4/3 米。这些爆炸记录的玩家系数为 2、NPC 系数为 1。

实际扣血最多等于剩余生命，基础规则量不再截成 200。NPC 开火使用已确认武器的同一份数值，取消固定 10 点；原 1,500 毫秒报告冷却仍是模拟限制。36 项 PSO 爆炸解析器固定受支持 SHA-256，验证文件内 120 字节结构、映射、指针和字段，不兼容输入在发布输出前明确失败。Java 目录记录来源哈希；原 XML/PSO 只读，输出（含外部资源的 JSON 报告）经过保护、独立临时文件和原子替换。

### 未完成范围与兼容

烟雾/BZ 持续曝光使用原版小数系数、半径增长/寿命和实际经过时间计算，跨服务端 tick 保留小数生命。原 21 个刚性部位骨矩阵已用于确定真实命中部位，普通头/肢体、护甲和头部道具保护分支已实现，见[精细战斗](combat-precision.md#简体中文)和[装备权威](equipment-authority.md#简体中文)。持续燃烧、属性/特殊弹药、完整近战相位、车辆碎裂伤害及原生爆炸分支留到[后续版本](p0-next-release.md#简体中文)；已准备火焰辅助类尚未被战斗调用。

完整服务端 0.4.7 目录需要启动器 0.2.19，原版量可能超过旧客户端 200 点校验上限；加入还要求新动作/装备/PED 姿态能力和独立生成的有效角色几何，旧客户端加入前明确失败；伤害继续由服务端决定。启动器取消玩家/NPC 的成功命中、伤害和击杀小提示，也取消近战受伤提示；原生战斗表现和生命更新继续执行，连接、可处理错误、本人的死亡和重生通知保留。

本地检查覆盖来源一致性、原版伤害/系数、双向生命、投射物碰撞、存活目标连续范围伤害及重生、队列/生命周期隔离、WebSocket 事件、小提示删除和资源/输出隔离；没有新增实机画面记录来证明完整原生一致性。各组件更新说明记录最终范围与兼容要求。

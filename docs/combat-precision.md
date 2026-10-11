# Combat precision and supported scope

## English

This release connects bounded hit rewind, original character hit components, armour absorption, supported head-prop protection and continuous gas exposure to the server combat path. Persistent body/ground fire and corpse-pose replication remain deferred; see [fire authority](fire-authority.md) and [follow-up scope](fivem-interactions-followup.md).

### Geometry and time

`tools/export_ped_collision.py` reads the supported original male/female ragdoll resources. Each has 21 original collision components: 17 capsules and four boxes. Ten allowed character models bind these shapes to their original skeletons. Derived geometry stays in the independent `server/world-data/ped-collision.json` and is not committed. Missing or incompatible data prevents enabling this combat capability.

Clients submit native bone matrices as observations. The server validates ownership, generation, lease, model, matrix orientation, distance from the accepted entity transform and skeleton segment lengths before accepting them. A pose is usable for 250 milliseconds. An invalid update preserves the last accepted entity and pose; it does not move the character or erase valid geometry. A player cannot shoot with a missing or expired own pose. An unavailable target pose can conservatively block a ray but cannot authorize damage. These bounds constrain observations; they are not proof that a hostile client ran the native engine honestly.

Player and NPC bullets use the actual nearest hit component. Explosions and gas use the nearest surface of the same components. A valid articulated-pose miss never falls back to an invented body capsule. Map obstruction is verified, and current vehicle blockers are checked again before delayed damage is committed.

The optional shot `server_time` identifies an exact recorded server baseline. The rewind window is 250 milliseconds, with capacity for every distinct millisecond in that window; there is no arbitrary timestamp interpolation. Future and unknown baselines are rejected. An older baseline actually published to that player safely uses current geometry. Entity generation, model, ownership epoch, life and attachment-parent identity fence historical and deferred hits, so an old shot cannot transfer to a respawned or migrated entity. Queued future shots execute against current geometry.

### Damage and protection

Damage retains the source weapon's network player/NPC modifier and distance falloff. The supported network hit-part branch treats head bone 31086 separately, neck 39317 as torso, and the original limb tags with the network limb modifier. Player bullet head critical damage uses the source minimum/maximum distance and extra-damage values, including native strict comparisons. This is the supported ordinary bullet branch, not a claim of every scripted or task-dependent GTA damage branch.

`tools/ped_damage_metadata.py` maps 683 original models to personality armour efficiency. Ordinary ammunition applies the original single-precision absorption/depletion arithmetic; the source `ArmourPenetrating` flag bypasses armour. Fractional health is retained internally between hits while the protocol publishes integer health. Armour-only hits still emit a damage event with zero health loss and the actual armour loss.

`tools/ped_protection_metadata.py` validates ten base and 18 DLC variation resources, native collection ordering, protection flags and the two-hit bulletproof threshold. Protection is derived from those flags. An ordinary hat does not automatically protect the head. A protective hat suppresses head extra damage and drops on the first eligible hit; a bulletproof helmet retains that protection through its second hit, then drops. The original `IgnoreHelmets` flag changes the relevant break calculation. Durability changes only after obstruction is confirmed clear. The server clears the head prop and publishes `helmet_broken`; a later appearance packet cannot restore that broken prop identity in the same life. A new life resets this protection state. Supported variation inputs contain no lightly-armoured components or bulletproof face components; those flags are not invented for other clothes.

### Continuous gas and remaining work

The smoke/BZ records provide a 25-second directed lifetime, native cloud expansion and fractional continuous coefficients. The server integrates these values over elapsed time, applies the original distance-damage flag, checks current component contact and obstruction, and stops exposure when the character leaves. Continuous gas does not also create a discrete first-frame blast. After a delayed server tick, damage integration is capped at 250 milliseconds rather than assuming an unobserved older pose. Shared active-area state lets late entrants obtain the current field.

❌ Persistent ignition, ground-fire propagation, water extinguishing, vehicle-wreck fire placement and task-dependent NPC terminal fire damage are not connected to the runtime. Prepared `Burning`/`FireCatalog` calculations do not enable them. Independent corpse-pose replication and complete native damage/task equivalence also remain next-version work. Existing Molotov impact/explosion handling does not imply persistent burning support.

### Verification and resource isolation

Local Java checks cover 57 rewind/armour cases, 29 head-prop cases, 12 hit-part cases, 16 pose/bounds/water validation cases, 27 continuous-exposure cases and ten NPC pose-transaction cases. They include a real original rest-pose fixture, wall-blocked helmet hits, deferred owner changes, respawn fencing, stale poses and fractional damage. The complete Java 17 server compiles. These are automated source/protocol/native-data checks; no rendered gameplay verification is claimed.

Metadata generators pin original engine/resource hashes and reject unsupported versions. Every output is outside player resources, including external resource roots. Output links to protected paths and hard links to inputs are rejected before generation; files are published through independent temporary files and atomic replacement. The head-protection check confirms unchanged hashes for its engine plus 14 RPF inputs. Tests and local evidence remain ignored and are not release source.

## 简体中文

本版已将有限射击回溯、原始角色命中部件、护甲吸收、受支持头部道具防护和连续毒气暴露接入服务端战斗流程。持续身体/地面燃烧与独立尸体姿态同步留待下一版，详见[火焰状态](fire-authority.md)和[后续范围](fivem-interactions-followup.md)。

### 几何与时间

`tools/export_ped_collision.py` 只读解析受支持资源的男女 ragdoll。每组使用原始 21 个碰撞部件，包括 17 个胶囊和四个盒体，并绑定十个允许角色模型的原骨架。派生几何存放于独立的 `server/world-data/ped-collision.json`，不提交到仓库；数据缺失或版本不兼容时不能启用该战斗能力。

客户端提交原生骨骼矩阵观测，服务端先核对归属、代次、租约、模型、矩阵方向、与已确认坐标的距离和骨架段长。姿态有效期为 250 毫秒。无效更新保留此前实体与姿态，不移动角色，也不清空已有有效几何。玩家自己的姿态缺失或过期时不能射击；目标姿态不可用时只能保守阻挡射线，不能授权扣血。这些约束限制观测范围，不代表能够证明恶意客户端诚实执行了原引擎。

玩家与 NPC 子弹使用实际最近命中部件，爆炸与毒气使用同组部件的最近表面。有效姿态下的未命中不会退回虚构人体胶囊。地图遮挡需经过确认，延迟伤害提交前还会复查当前车辆阻挡。

射击可选 `server_time` 必须对应记录过的精确服务端基线。回溯上限 250 毫秒，容量覆盖窗口内每个毫秒，不对任意客户端时间进行插值。未来或未知基线被拒绝；确实发送给该玩家但已经过期的基线改用当前几何。历史与延迟命中核对实体代次、模型、归属时期、生命及附着父实体身份，旧子弹不会转移到重生或迁移后的实体。排队等待发射的子弹使用执行时的当前几何。

### 伤害与防护

伤害保留原武器对玩家/NPC 的网络倍率与距离衰减。已接入的网络部位分支将 31086 头骨单独处理，39317 颈部视为躯干，原始肢体标签应用网络肢体倍率。玩家子弹爆头使用来源中的最小/最大距离与额外伤害系数，并保留原生严格比较边界。这是受支持的普通子弹分支，不宣称覆盖所有脚本或任务相关 GTA 伤害分支。

`tools/ped_damage_metadata.py` 将 683 个原模型映射到 personality 护甲效率。普通弹药使用原单精度吸收/耗尽公式，原 `ArmourPenetrating` 标记绕过护甲。内部保留连续命中间的小数生命值，协议发布整数生命值。仅损失护甲时仍发送事件，生命伤害为零并包含实际护甲损失。

`tools/ped_protection_metadata.py` 核验十份基础与 18 份 DLC 外观资源、原集合加载顺序、防护标记及防弹头盔两次命中的阈值。防护来源于真实标记，普通帽子不会自动获得爆头保护。保护帽在首次合格命中时抑制额外爆头伤害并掉落；防弹头盔在第二次命中仍抑制额外伤害，随后掉落。原 `IgnoreHelmets` 标记调整对应破损计算。只有遮挡确认通过后才修改耐久。服务端清除头部道具并发布 `helmet_broken`，同一生命内的后续外观包不能恢复已破损的同一道具身份；新生命重置防护状态。受支持外观输入没有轻甲部件或防弹面部部件，不为其他衣物虚构这些标记。

### 连续毒气与后续范围

原 smoke/BZ 记录提供 25 秒定向寿命、云团扩张与小数持续伤害系数。服务端按经过时间积分，应用原距离伤害开关，并检查当前部件接触与遮挡；离开区域后停止暴露。连续毒气不会在首帧额外附加一次离散爆炸。服务端 tick 延迟后，伤害积分最多取 250 毫秒，不假定更早且未观测到的姿态。共享活动区域状态支持晚加入者接收当前毒气场。

❌ 持续点燃、地面火传播、入水熄灭、车辆残骸火焰布点和 NPC 任务相关终结燃烧伤害尚未接入运行流程。已准备的 `Burning`/`FireCatalog` 算法不会启用这些功能。独立尸体姿态同步以及完整原生伤害/任务等价也留待下一版。已有燃烧瓶命中与爆炸处理不代表已支持持续燃烧。

### 验证与资源隔离

本地 Java 检查覆盖 57 项回溯/护甲、29 项头部道具、12 项命中部位、16 项姿态/包围盒/水面校验、27 项连续暴露和十项 NPC 姿态事务。包括真实原始静止姿态样本、墙体阻挡不损耗头盔、延迟归属改变、重生隔离、过期姿态与小数伤害。完整 Java 17 服务端编译通过。这些是自动化源码、协议与原生数据检查，不宣称已完成游戏画面验证。

元数据生成器固定原引擎与资源摘要，不兼容版本明确失败。所有输出均在玩家资源之外，并覆盖外部资源目录；指向受保护路径的符号链接和输入硬链接在生成前被拒绝，文件使用独立临时文件和原子替换发布。头部防护检查确认原引擎及 14 份 RPF 输入的哈希未变。测试与本地证据保持忽略，不作为发布源码提交。

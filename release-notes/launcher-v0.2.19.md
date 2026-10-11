## English

**Category: Launcher · Version: 0.2.19**

### Changes

- Add validated native character-action sampling and transport for cover, roll, climb/ladder requests, swimming, diving and active ragdoll. Remote replicas use an independent upper-body reload task, resident animation/clip/parameterized gait phase and rate correction, exact compatible blend weights, cover aim-intro/outro transitions and bounded matching-ladder progress. Missing or ambiguous native networks are skipped.
- Sample the original 21 rigid-part bone matrices for server hit geometry. Apply accepted living-ragdoll poses only to the replica's existing private articulated body, with pointer, ownership, array and joint bounds checked before writes. Corpse bone synchronization remains deferred.
- Reconcile private server-owned weapons, shared ammunition, magazines, reload tokens and five shared supply points. Track individual pending shots so delayed acknowledgements cannot refill consumed rounds; preserve native reload completion while a shot is awaiting confirmation. Confirmed helmet breaks clear only the matching head prop in the same character life.
- Add verified combined movement/aim with firing disabled; clear native movement, aim, reload and melee caches across respawn, handle, teleport and seat transitions. New tasks wait for the exact native seat or completed old-seat release.
- Preserve repeated explosive-weapon firing when a native reload flag overlaps. Drain failed/expired collision handles independently of the eight active query slots, within a 64-handle total limit and four launches per tick.
- Reconcile established leased NPC exits without immediate warp-back, and retain the current parent/generation/local-offset baseline for character and verified vehicle sticky charges.
- Add deduplicated original cosmetic blood, retain native player/NPC death tasks and the local death-camera shake/depth-of-field command. Remove hit/damage/kill popups while retaining authoritative state and actionable notices.
- Build four project-owned online hooks from required WAT sources; include them in the source package. The local recovery tool exports full WAT, 91,111 named functions and 298 audited multiplayer interfaces, with standard-section round-trip equality. Recovered game material is excluded from releases.

### Compatibility and validation

Use this launcher with server 0.4.7. The server requires `world_v2`, `actions_v2`, `equipment_v1` and `ped_pose`; older clients are rejected before joining. Unsupported original engine versions still fail explicitly. The launcher reads original game resources and creates managed runtime copies outside their directory. Offline bytes remain identical; the online runtime digest changes and old caches are rebuilt. No original engine or game resources are distributed.

Local regressions cover native task transitions, compatible phases/blends, ladder/cover matching, living-ragdoll pointer guards, equipment prediction and reloads, transport limits, lifecycle fencing, repeated shots and resource/output isolation. Full recovered WAT recompilation preserves standard sections. These checks do not claim rendered two-client gameplay validation. macOS uses development/ad hoc signing and is not notarized.

Full missing-network reconstruction, complete upper/lower-body transitions, climb/vault attachment, ladder mount/dismount progress and corpse bone synchronization are deferred. See [character actions](../docs/character-actions.md), [equipment authority](../docs/equipment-authority.md), [engine source](../docs/online-engine-source.md) and the [remaining P0 plan](../docs/p0-next-release.md).

## 简体中文

**分类：启动器 · 版本：0.2.19**

### 更新内容

- 增加经过校验的原生角色动作采集与传输，覆盖掩体、翻滚、攀爬/梯子请求、游泳、潜水及活体布娃娃。远端使用独立上身换弹任务，对已有动画/片段/参数化步态同步相位和速率，匹配兼容子树的混合权重、掩体瞄准/收回及同一梯子的有限进度；缺失或歧义网络不强行套用。
- 采集原版 21 个刚性部位骨矩阵供服务端命中几何使用。已接受的活体布娃娃姿态仅应用于替身现有的私有关节体，写入前检查指针、归属、数组和关节范围。尸体逐骨骼同步留到后续版本。
- 对齐服务端私有武器、共享弹药、弹匣、换弹令牌及五个共享补给点。逐发跟踪待确认射击，防止迟到确认补回已消耗子弹；射击尚未确认时完成原生换弹也能正确处理。确认头盔损坏后仅清理同一生命中匹配的头部道具。
- 增加禁用开火的已核验联合移动瞄准；重生、句柄、远距离纠正和座位切换清理旧移动、瞄准、换弹及近战缓存，新任务等待准确原生座位或旧座位释放完成。
- 保留换弹标志重叠时的连续爆炸武器射击。失败/过期原生碰撞句柄独立于八个活跃查询槽排空，总量最多 64，每次 tick 最多新建四个查询。
- 协调已确认原生入座后的租约 NPC 离车，避免立即放回；角色及已核验车体黏弹保留当前父实体、代次和局部偏移基线。
- 增加去重的原生血迹，保留玩家/NPC 原生死亡任务及本人死亡镜头抖动/景深。取消命中、伤害、击杀小提示，保留权威状态与可处理通知。
- 四份自有在线钩子从必需 WAT 源码构建并纳入源码包。本地恢复工具导出完整 WAT、91,111 个具名函数和 298 个多人接口，标准节往返编译逐字节相同；恢复的游戏材料不进入发布包。

### 兼容与验证

配套服务端 0.4.7 使用。服务端要求 `world_v2`、`actions_v2`、`equipment_v1` 和 `ped_pose`，旧客户端在加入前被明确拒绝。不兼容原引擎仍明确失败。启动器只读原游戏资源，在资源目录之外生成受管理运行副本；离线副本逐字节一致，在线摘要更新并重建旧缓存，不分发原引擎或游戏资源。

本地回归覆盖原生任务切换、兼容相位/混合、梯子/掩体匹配、活体布娃娃指针保护、弹药预测/换弹、传输容量、生命隔离、连续射击和资源/输出保护。完整恢复 WAT 重编译保留标准节；这些检查不宣称已完成双客户端实机画面验证。macOS 使用开发/ad hoc 签名，尚未公证。

缺失动作网络重建、完整上下身过渡、攀爬/翻越附着、梯子挂接/离开进度及尸体逐骨骼同步留到后续版本。见[角色动作](../docs/character-actions.md#简体中文)、[装备权威](../docs/equipment-authority.md#简体中文)、[引擎源码](../docs/online-engine-source.md#简体中文)与[剩余 P0 计划](../docs/p0-next-release.md#简体中文)。

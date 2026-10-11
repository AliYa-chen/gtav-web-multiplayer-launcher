# Remaining P0 work

## English

Launcher 0.2.19 and server 0.4.7 ship the completed, bounded work described in their release notes. The complete P0 character-action and combat-detail rows remain ❌. The following unfinished work is deferred to a later release; prepared helpers and isolated native arithmetic do not imply an enabled feature.

| Area | Implemented this release | Remaining work |
| --- | --- | --- |
| Upper/lower body and gait | Independent reload layer; unique resident phase/rate/parameter correction; exact compatible blend subtrees | Rebuild missing motion networks, disambiguate duplicated layers, support custom modifiers and complete transition state |
| Cover and climbing | Native cover/aim transitions, roll and swim requests; same-ladder steady-state matching | Exact cover height/lean, climb/vault attachment, missing ladders and mount/dismount progress |
| Ragdoll/death | Validated living-ragdoll rigid-part presentation; native corpse death tasks | Corpse bone/root presentation with a separate leased visual cache and complete lifecycle cleanup; complete scripted death camera |
| Persistent fire | Version-pinned metadata and independently checked heat/body/surface calculations | Wire server-owned fire identity, ground contact/obstruction, ignition/extinction, water observations and client visuals; include NPC task and vehicle-wreck branches |
| Reload timing | Server tokens, ammunition conservation, original default clip-duration gate | Exact native insertion events and all first-person, cover, skill and animation-rate branches |
| Damage/physics | Original ordinary bullet hit parts, ordinary armour, protective head props, bounded rewind and continuous gas | Character-stat/special-ammunition branches, complete melee phases, native explosion and all-model vehicle damage physics |

Each follow-up must preserve read-only player resources, version checks, lease/generation fences and output guards. Damage and equipment remain server-owned. Test criteria include stale/replayed inputs, owner and generation changes, missing/ambiguous streamed assets, private output ownership, and unchanged original hashes. Live visual evidence must be recorded separately from static or mock-native checks.

Details: [character actions](character-actions.md), [combat precision](combat-precision.md), [equipment authority](equipment-authority.md), [fire preparation](fire-authority.md) and [vehicle damage](vehicle-damage.md).

## 简体中文

启动器 0.2.19 与服务端 0.4.7 交付更新说明中明确列出的已完成范围。完整 P0「角色动作」和「细分战斗」仍保持 ❌；以下剩余项留到后续版本。已准备的辅助类或原生隔离算术验证不等于功能已经启用。

| 范围 | 本版完成 | 后续工作 |
| --- | --- | --- |
| 上下身与步态 | 独立换弹层；唯一已有节点相位/速率/参数；精确兼容混合子树 | 缺失动作网络、重名层区分、自定义混合修饰器和完整过渡状态 |
| 掩体与攀爬 | 原生掩体/瞄准过渡、翻滚/游泳请求、同梯子稳定状态匹配 | 精确掩体高度/探身、攀爬/翻越附着、缺失梯子和挂接/离开进度 |
| 布娃娃与死亡 | 经校验活体刚性部位姿态；保留原生尸体死亡任务 | 独立租约视觉缓存的尸体骨骼/根位置与生命周期；完整脚本死亡运镜 |
| 持续火焰 | 固定版本元数据与独立核验的热量/身体/地面火计算 | 接入服务端火焰身份、接触/遮挡、点燃/熄灭、水面观测和客户端视觉，补 NPC 任务与载具残骸分支 |
| 换弹时序 | 服务端令牌、弹药守恒及原默认片段时长门槛 | 原生插匣事件，以及完整第一人称/掩体/技能/动画倍率分支 |
| 伤害与物理 | 原普通枪弹部位、普通护甲、头部道具保护、有界回溯和持续毒气 | 属性/特殊弹药、完整近战相位、原生爆炸和全车型损伤物理 |

后续继续遵守玩家资源只读、版本校验、租约/代次和输出保护；伤害与装备仍由服务端决定。验证覆盖过期/重放、所有权与代次变化、缺失/歧义流式资源、私有输出归属和原始输入哈希不变，实机视觉证据与静态/原生替身检查分开记录。

详见[角色动作](character-actions.md#简体中文)、[精细战斗](combat-precision.md#简体中文)、[装备权威](equipment-authority.md#简体中文)、[火焰准备](fire-authority.md#简体中文)与[载具损伤](vehicle-damage.md#简体中文)。

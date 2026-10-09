# AI 行为与事件迁移

本轮将公共 NPC 的行为状态、危险记忆、目标和警员追捕决定迁入 `WorldAi`。服务器给出同一份 `ai_task`；获得活动模拟租约的客户端执行引擎任务，其他客户端只应用共享实体状态。服务器尚未具备 RAGE 的道路、导航网格、碰撞世界和完整场景行为树，因此不能把这次更新描述为完整移植 GTA Online 或全部单机脚本。

审计日期：2026-10-09。审计读取实际本地资源、完整解析 XML 配置并解码选定 WASM 函数，没有启动游戏。可运行以下命令重新生成完整事件清单和证据：

```sh
python3 -B tools/audit_world_ai.py
```

维护者本地回归文件不随源码分发。完整证据保存到忽略提交的 `docs/snapshot/world-ai-evidence.json`。工具记录资源 SHA-256、全部场景名称、每条触发规则的事件/条件/动作，以及 WASM 任务接口真实类型。

## 本地 AI 实际包含什么

| 资源 | 本次完整读取到的内容 | 对公共战局的影响 |
| --- | --- | --- |
| `common/data/ai/scenarios.meta` | 216 个场景、16 个场景类型组；含动画、道具、生成概率、雨天条件和退出规则 | 场景需要共享实例、唯一占用者和统一生命周期。相同天气不能保证各客户端生成相同场景。 |
| `common/data/ai/scenariotriggers.meta` | 180 条规则、59 种事件、9 种动作类型 | 枪声、伤害、危险车辆、尸体、火灾、爆炸、冲突和脚本指令都可以打断本地 AI。公共实体不能继续自行接受整套本地事件。 |
| `common/data/pedperception.meta` | `DEFAULT_PERCEPTION` 视觉/听觉均 60 米；侵入范围 25 米，近距 4 米，视觉方位和高程角另外受限 | 本轮只使用 60 米作为服务器危险事件距离，不假装拥有视觉角度、遮挡或听觉传播模拟。 |
| `common/data/relationships.dat` | 玩家、平民、警察、保安、帮派、军队、动物等关系组；`PLAYER` 对 `PLAYER` 为 `Like` | 玩家互伤必须来自公共战局战斗规则，不能依赖原单机关系组。当前普通 NPC 不按所有帮派/动物关系全面还原。 |
| `common/data/levels/gta5/popcycle.dat` | 115 个命名人口周期表；文件说明工作日/周末、两小时时段、行人/场景/车辆/停车预算 | 这是真实密度输入，尚未全面接入服务器地区模型和道路落点。当前有限人口生成器不等于还原这 115 个区域。 |
| `common/data/dispatch.meta` | 12 种调度类型，包括警车、船、直升机、SWAT、路障、救护车、消防、帮派和军队 | `WorldLaw` 目前只实现公共出生区的有限警车/警员响应，并未接管全部 12 种服务。 |

触发动作统计是：即时退出 62、普通退出再响应 46、胆怯退出再响应 23、威胁退出 23、战斗退出 9、震惊反应 8、逃跑 6、脚本退出 2、转头观察 1。这些是规则行数，并不是任务种类或可运行脚本的数量。

`EVENT_DAMAGE` 会立即退出场景；`EVENT_GIVE_PED_TASK` 和 `EVENT_SCRIPT_COMMAND` 进入脚本退出；`EVENT_POTENTIAL_BLAST` 可以进入逃跑。资源还明确包含 `EVENT_SHOT_FIRED`、`EVENT_GUN_AIMED_AT`、`EVENT_EXPLOSION`、`EVENT_PED_COLLISION_WITH_PLAYER`、`EVENT_SHOCKING_DEAD_BODY`、`EVENT_SHOCKING_SEEN_CAR_STOLEN` 等。具体动作还取决于胆怯/警察/保安/帮派身份和能否快速退出，不能只按事件名复制成一次网络广播。

## 脚本内容与引擎接口的证据边界

`script.rpf`、`script_rel.rpf`、`script_wasm.rpf` 均为 RPF7，目录加密标识是 `0x0ffffff9`。其头中的记录数分别为 1,027、711、9。本次没有解密目录、提取 YSC 或反编译脚本正文，不能列出这些容器里每个任务脚本的完整控制流，也不能把容器记录数当作脚本总数。

所审计原始 `game.wasm` 的 SHA-256 为 `11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0`。以下函数均完成指令解码；这是静态 ABI 证据，不是运行时场景验证：

| 函数索引 | 函数 | 类型 |
| --- | --- | --- |
| 41485 / 80397 | 行人/车辆人口 `Process` | `() -> void` |
| 60564 | `CommandTaskStandStill` | `(i32, i32) -> void` |
| 60575 | `CommandTaskVehicleDriveToCoordLongRange` | `(i32, i32, i64, f32, i32, f32) -> void` |
| 60576 | `CommandTaskVehicleDriveWander` | `(i32, i32, f32, i32) -> void` |
| 60577 | `CommandTaskGoStraightToCoord` | `(i32, i64, f32, i32, f32, f32) -> void` |
| 60591 | `CommandTaskWanderStandard` | `(i32, f32, i32) -> void` |
| 60593 | `CommandTaskCombat` | `(i32, i32, i32, i32) -> void` |
| 52957 / 52958 | 调度启用/阻止调度资源创建 | `(i32, i32) -> void` |

WASM 的名称节也包含战斗掩体、威胁响应、SmartFlee、场景链等实际类和方法，但仅凭存在这些名称，不能声称这些系统已经移入 Java 服务端。

## 在线脚本由服务器策略统一停用

公共战局不提供单机剧情。服务器在 `welcome`、玩家 profile、完整世界快照和增量中下发同一 `session_policy`：

```json
{"revision":1,"story_enabled":false,"local_script_mode":"suspend_after_ready","allowed_scripts":[],"mission_events":"server_only"}
```

初始加载和公共角色放置完成后，在线 `scrThread::Run` 服从服务器脚本白名单。当前白名单为空，所有本地脚本 VM（包括未知剧情、任务触发器和随机事件）都停止继续解释执行，客户端不再凭自己的审核黑名单决定哪些剧情能运行。该策略生效后断线也不恢复单机剧情。离线引擎保持原样。

桥接回调仍在解释器 block 首部执行，之后才根据服务器策略跳过本轮 VM；原 TLS 与活动线程恢复尾部仍执行。C++ 引擎的流式资源、物理、输入、HUD 和服务端实体适配不依靠重新启用剧情 VM。策略插入在原始指令偏移 110，恢复边界为 32869；构建器核对完整函数和边界后才生成在线副本。

服务器没有接受任意脚本名、故事触发器、任务进度或场景创建的消息入口。当前公共交互仅允许 `enter_vehicle`、`leave_vehicle`、`melee` 和 `detonate`。今后增加的公共任务需要服务端明确建立任务状态机、实例和事件规则，不允许客户端凭单机脚本自行发布。

所有共享角色使用武器/火焰/爆炸/近战防护，避免本地原生伤害与服务器生命事务叠加；摔落、碰撞与溺水仍可提交环境候选。服务器拒绝客户端直接改写血量或敌对目标，客户端仅按服务端结果显示投射物、无伤害爆炸和范围标记。

## 服务器任务状态机

`WorldAi` 不持有 Registry 写权限。其输入仅是服务器接受的射击/伤害和共享实体快照；输出是每个 NPC 的不可变任务。客户端报告的伤害值、观察到的血量降低、播放的射击动画都不能直接进入危险事件 API。

| 状态 | 决策来源 | 客户端执行 |
| --- | --- | --- |
| `idle` | 死亡、租约无效、警力冻结或乘客 | 清理主动任务/保持副本状态。 |
| `wander` | 有活动租约、未遇到危险的步行平民 | 引擎漫游；局部寻路仍由引擎执行。 |
| `drive` | Registry 确认的唯一司机且车辆属于同一模拟者 | 常规交通 12 米/秒；危险逃离 22 米/秒；警车追捕 25 米/秒。有服务端目的地时执行驾驶到点。 |
| `flee` | 60 米范围内已接受枪声/伤害，或自身遭受已提交攻击 | 服务器给出水平远离危险点 25 米的确定性目的地，步行速度 3 米/秒。该点尚未经导航网格和地面碰撞验证。 |
| `combat` | 受害的武装 NPC 对直接攻击者，或 WorldLaw 指定的警察目标；距离不超过 40 米 | 对指定目标执行战斗，报告可开火候选；服务端另做射速、距离、租约和伤害事务校验。 |
| `pursue` | 合法敌对目标在 40 米外 | 步行追向服务器确认位置，速度 2.5 米/秒；此时不允许远程扣血。 |

危险记忆持续 10 秒。直接受伤优先于附近伤害，附近伤害优先于枪声；同优先级选择最近发生的事件。当前平民不因持有武器就主动攻击玩家，只有直接受伤的武装 NPC 可以反击。枪声和伤害只在服务器接受动作/提交伤害后记录；警察的目标始终来自 `WorldLaw`。

目的地由服务器确定，重叠坐标使用实体 ID 派生逃离方向，不使用各客户端的随机方向。普通漫游和驾驶仍会调用原引擎寻路，它们的路线并未在 Java 中重算。危险事件表最多保留 128 个项目，过期或源实体代次不符会清理；被删除实体的任务也会清理。

## 接入接口与一致性

```java
WorldAi ai = new WorldAi(registry.worldEpoch());
ai.reportAcceptedShot(attacker, acceptedWeapon, acceptedOrigin, now);
ai.reportAcceptedDamage(attacker, victimAfterCommit, actualDamage, now);
List<String> changed = ai.tick(now, registry.snapshot().entities(), worldParticipants, law);
Map<String,Object> task = ai.taskForEntity(entityId);
boolean currentTarget = ai.authorizesShot(npc, victim, now);
```

`tick` 返回任务变化/删除的实体 ID，由 `WorldService` 把仍存在的实体通过 `touchTrusted` 放入现有连续快照/增量流。无需另建一条缺少重放和版本保障的 AI 广播通道。`revision()` 是任务整体版本；`ai_task.revision` 是该实体最近一次决策版本，与实体姿态 revision 分开。

任务字段包括 `entity_id`、`generation`、`owner_epoch`、`action`、`reason`、目标实体/代次/确认位置、`destination`、`speed`、`vehicle_entity_id` 和 `expires_at_tick`。所有权交接产生新任务版本；客户端不能用旧 owner epoch 的任务控制新租约实体。存活玩家不接收 NPC 任务，乘客不能抢司机任务，NPC 也不能取得玩家占用车辆的驾驶权。

行为类型和目标变化会立即发布；位置变化达到 3 米且距上次决策至少 500 毫秒时更新追踪任务，避免每帧重启动作。`authorizesShot` 再核对当前动作、攻击者/目标代次、owner epoch、活动租约、已确认模拟输入、武器、距离和危险记忆期限。它不验证墙体遮挡，不能替代完整弹道计算。

## 验证与剩余工作

自动测试覆盖公共 NPC/玩家隔离、不变状态不增版、危险半径/超时、武装反击、目标替换拒绝、旧代次和旧租约拒绝、远距离拒绝、警员追捕/冻结、共享驾驶位、乘客、车辆租约冲突、任务清理、零距离安全和乱序输入确定性。

后续完整能力包括场景点解码与唯一占用、地区/时段人口表、交通道路图、真正视线与听觉传播、掩体/阵营/动物差异、火灾/爆炸/偷车/碰撞的可信事件，以及救护/消防/直升机等调度。它们有本地资源依据，但本轮未实现完整的服务端状态机。

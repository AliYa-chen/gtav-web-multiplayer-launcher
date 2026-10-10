# NPC perception and pursuit / NPC 感知与追踪

## English

Server 0.4.4 adds confirmed line of sight to NPC combat and replaces pursuit of an unseen target's live position with remembered evidence. Active officers assigned to the same law response can share sightings for pursuit. Each officer still needs its own valid visibility confirmation to shoot. Publication and US rollout are handled by the existing workflow; source version alone does not prove deployment.

### Sight and shooting

`WorldAi` chooses a lawful hostile target: a direct attacker for an armed NPC acting in self-defense, or the target assigned by `WorldLaw` to an active officer. `WorldPerception` checks that target within 60 metres. It combines loaded static collision with the existing server-issued, leased `physics_queries` geometry channel; clients cannot submit arbitrary visibility claims.

| Rule | Behavior |
| --- | --- |
| Sight query | One eye-to-eye segment, 1.5 m above each confirmed entity position; range up to 60 m. |
| Static material | `visibility` uses `SEE_THRU`; `shot` retains its separate `SHOOT_THRU` rule. Seeing a target does not guarantee that a bullet can pass through the intervening material. |
| Refresh | At most once per 500 ms for a tracked target, subject to the shared query budget. |
| Confirmation | Valid for less than 1,000 ms from the sampled positions. |
| Invalidation | Either entity changing generation, owner or owner epoch, losing its valid lease/life state, or moving more than 0.75 m from the sample prevents use of old evidence. |
| Missing evidence | Unknown or incomplete results, timeouts, and absence of a capable leased observer never grant visibility. A static query with no hit alone does not prove a clear path. |
| Combat | Requires the NPC's own valid confirmation and a target within 40 m, plus the existing weapon, identity, lease, task, and cooldown checks. |
| Damage | The existing final `shot` obstruction query still runs before damage is committed. |

No active `physics_queries` observer means NPCs cannot shoot. Native geometry is a constrained client observation, not an independent server-side RAGE physics simulation. Query tickets, deadlines, identities, and geometry validation bound that trust; they do not eliminate it.

### Lost targets and shared sightings

A confirmed sighting stores the sampled target position for up to 10 seconds. If sight is lost, the NPC pursues that historical position. Moving the hidden target does not continuously move the pursuit destination. Within 1.5 m of the remembered point the NPC waits for new evidence, and expired memory stops authorizing pursuit to that point.

Server-accepted attacks can also provide a historical source position for self-defense or police pursuit. This evidence is captured when the accepted event occurs; it does not reveal a hidden target's later coordinates and does not authorize shooting. This remains distance-based event hearing, without acoustic propagation or occlusion.

`WorldAi` collects sightings before assigning tasks in a second pass. Active officers in the same `WorldLaw` response receive the same available report regardless of entity iteration order. Reports are bound to the response and target identity, generation, owner and owner epoch. They survive the original observer's death or lease transfer while teammates remain active, without extending the original ten-second deadline. A frozen response or changed target identity clears them. An officer receiving a report can pursue its position, but cannot borrow the reporting officer's shooting permission.

Visibility evidence expires independently of the task lifetime. Refreshing a sight query does not by itself publish a new combat task every 500 ms and repeatedly restart the native combat behavior.

Pursuit uses the existing pedestrian navigation, blocked-route handling, and ownership handover. No route through installed navigation means waiting/replanning, subject to the existing navigation rules.

### Runtime status

`/health` and `/world` expose `ai_perception`. The AI snapshot also includes its `perception` object. These values describe runtime state, not a declaration of complete gameplay support:

| Field | Meaning |
| --- | --- |
| `authority` | `server_directed_leased_geometry`. |
| `sight_radius` | Maximum query distance in metres. |
| `tracked_contacts` / `pending_queries` | Current tracked NPC contacts / pending native queries. |
| `queries` / `visible_results` | Submitted queries / accepted clear results. |
| `blocked_results` | Blocked observations, including repeated static checks; not a count of unique obstacles. |
| `unknown_observations` / `throttled_queries` | Observations without valid visibility / query attempts deferred by the budget. |
| `confirmation_valid_ms` / `memory_ms` | Confirmation and sighting-memory limits. |

### Compatibility and remaining scope

This is a server-only change compatible with the existing launcher 0.2.16 client bridge. It does not require a launcher rebuild, engine adaptation, resource extraction, or writes to game resources. Existing independent world data remains in place.

NPC weapons retain the simplified 1,500 ms cooldown and 10-point damage model. Full field-of-view angles, cover selection, tactical maneuvers/formations, dynamic vehicle occlusion, full-map collision/navigation, and broader police dispatch are unfinished. Static collision and pedestrian navigation remain limited to the existing spawn-area coverage. This update does not claim native GTA Online behavior or complete gameplay synchronization.

The README marks only confirmed sight, remembered-position pursuit, and response-scoped sighting exchange as complete. Current validation evidence belongs in the [0.4.4 release notes](../release-notes/server-v0.4.4.md). The release workflow deploys US experimental before US main and records actual results; China deployment requires separate explicit authorization.

---

## 简体中文

服务端 0.4.4 将已确认视线接入 NPC 战斗，并把丢失目标后的追踪改为基于历史证据的位置。同一执法响应中的活动警员可以共享目击位置用于追踪，每名警员开火仍须具有自己的有效视线确认。发布及美国线路更新由既有工作流执行；源码版本本身不证明部署已成功。

### 视线与射击

`WorldAi` 先选择合法敌对目标：武装 NPC 自卫时的直接攻击者，或 `WorldLaw` 为活动警员分配的目标。`WorldPerception` 在 60 米内查询目标视线，结合已加载静态碰撞和现有服务端发起、受租约约束的 `physics_queries` 原生几何通道。客户端不能任意提交“看见了目标”的声明。

| 规则 | 行为 |
| --- | --- |
| 视线查询 | 从双方已确认实体位置上方 1.5 米发出单条眼睛到眼睛的线段，最大距离 60 米。 |
| 静态材质 | `visibility` 使用 `SEE_THRU`，`shot` 保留独立的 `SHOOT_THRU` 规则。能看见不代表子弹能穿过中间材质。 |
| 刷新 | 每个跟踪目标最多每 500 毫秒刷新一次，受共享查询预算限制。 |
| 确认有效期 | 从采样位置的时间起不足 1,000 毫秒。 |
| 失效 | 任一方代次、所有者或 owner epoch 改变，失去有效租约/存活状态，或相对采样位置移动超过 0.75 米，均阻止使用旧证据。 |
| 证据缺失 | 未知、不完整、超时及没有有效观察者均不授予可见性。仅静态查询未命中也不能证明无遮挡。 |
| 战斗 | NPC 自身必须有有效确认且目标在 40 米内，同时通过既有武器、身份、租约、任务及冷却校验。 |
| 伤害 | 提交伤害前仍执行已有最终 `shot` 遮挡查询。 |

没有支持 `physics_queries` 的活动观察者时，NPC 不会开火。原生几何仍是受限的客户端观测，不是服务端独立运行的 RAGE 物理。一次性票据、期限、身份和几何校验约束该信任边界，但不能消除它。

### 丢失目标与共享目击

一次确认将采样到的目标位置最多保留 10 秒。丢失视线后，NPC 追向该历史位置；目标在遮挡后继续移动不会持续改变追踪目的地。进入记忆点 1.5 米内后等待新证据，记忆过期后不再凭该点继续追踪。

服务端已接受攻击也可为自卫或警方提供历史声源位置。位置在接受事件时记录，不能揭示隐藏目标之后的位置，也不授予射击权限。当前听觉仍是按距离筛选的事件提示，不包含声学传播与声音遮挡。

`WorldAi` 先汇总目击，再以第二遍分配任务。同一 `WorldLaw` 响应内的活动警员得到相同可用情报，不依赖实体遍历顺序。情报绑定响应和目标身份、代次、所有者及所有权 epoch。原报告者死亡或移交租约后，仍活动的队友保留已收到的情报，但不延长原来的十秒期限；响应冻结或目标身份变化时清理。接收情报的警员可以追向报告位置，不能借用报告者的射击权限。

视线证据的有效期与任务生命周期独立。仅刷新视线查询不会每 500 毫秒发布一次新战斗任务，从而反复重启原生战斗行为。

追逐继续使用现有步行导航、无路处理和模拟权移交机制。已安装导航但找不到可行路线时，沿用等待及重新规划规则。

### 运行状态

`/health` 和 `/world` 新增 `ai_perception`，AI 快照内也包含 `perception` 对象。字段反映运行时状态，不代表完整玩法已实现：

| 字段 | 含义 |
| --- | --- |
| `authority` | `server_directed_leased_geometry`。 |
| `sight_radius` | 最大查询距离，单位米。 |
| `tracked_contacts` / `pending_queries` | 当前跟踪的 NPC 目标数 / 待处理原生查询数。 |
| `queries` / `visible_results` | 提交查询数 / 已接受无遮挡结果数。 |
| `blocked_results` | 阻挡观测次数，包含重复静态检查，不是独立障碍物数量。 |
| `unknown_observations` / `throttled_queries` | 没有有效视线的观测次数 / 因预算延后查询次数。 |
| `confirmation_valid_ms` / `memory_ms` | 确认有效期 / 目击记忆上限。 |

### 兼容与剩余范围

本轮只修改服务端，兼容启动器 0.2.16 的现有客户端桥。不需要重新构建启动器、适配引擎、提取资源或写入玩家游戏目录。已有独立世界数据保持原样。

NPC 武器仍采用 1,500 毫秒冷却和 10 点伤害的简化模型。完整视野角度、掩体选择、战术机动/队形、动态车辆遮挡、全地图碰撞/导航和扩大警方调度范围仍未完成。静态碰撞与步行导航继续限于已有出生区覆盖。本轮不宣称还原原 GTA Online 行为或完成真实玩法同步。

README 仅将已确认视线、记忆位置追踪和同一响应内目击共享标为完成。本轮实际验证记录见 [0.4.4 更新说明](../release-notes/server-v0.4.4.md)。既有工作流按美国实验、正式顺序部署并记录实际结果；中国线路需要另行明确授权。

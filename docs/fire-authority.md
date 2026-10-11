# Fire authority preparation

## English

❌ Persistent burning is deferred to the next release. `Burning.java` and the generated `FireCatalog.java` are prepared calculation modules; `CombatWorld` does not call them in this release. No persistent player/NPC ignition state, shared ground-fire lifecycle, or water-extinguishing transaction is enabled by these modules. The running combat path retains its geometric Molotov impact handling and continuous tear-gas exposure. These must not be described as complete native fire behavior.

✅ The supported original engine and metadata have been read without modification. `tools/fire_metadata.py` pins the engine, `explosion.ymt` and `explosionfx.dat`, producing 36 explosion-to-fire mappings. It rejects incompatible inputs. Source and optional report destinations share output validation, including external resource roots, symbolic links and input hard links; publication uses fresh temporary files and atomic replacement.

The prepared arithmetic includes:

- Original proximity-scan heat increments, cooling, scan intervals and first-scan jitter; the native PED bounding box is narrowed to its central third in X/Y, preserving Z.
- Original ignition gates. This resource version omits the separate player-ignition and ignore-radius flags; both native parser defaults are false. Ordinary explosion ignition therefore targets eligible NPCs. FIRE damage and `DIR_FLAME` have a separate native branch.
- Body-fire damage at 18.75 points per second, with native default durations of two seconds for nearby-fire player ignition, seven seconds for explosion player ignition, and ten seconds for NPCs. The seven-second branch remains an arithmetic capability, not a claim that ordinary supported explosions authorize it.
- Server-seeded native random arithmetic for surface-fire candidates, the original two-metre downward probes, lifetime/radius/fuel progression, and explicit extinguishing. The supported binary overrides the first candidate lifetime to 20–25 seconds and reuses it; the original FIRE branch places later candidates in the Y/Z plane. Isolated native execution confirms these version-specific details.

The next release must connect these calculations to server-owned fire identities, entity generations, leases, geometry and line-of-sight results; bounded native water/bounding-box observations; authoritative ignition, damage and extinction events; and client visual cleanup. A sampled fire candidate is not an authorized fire until its downward contact and source-to-contact obstruction checks pass. Clients must never authorize heat, damage, duration, count or position. Vehicle-wreck fire placement and the original NPC task-dependent terminal damage branch also remain outside this implementation. The latter has an isolated predicate only; ordinary 18.75-per-second integration is not full NPC task parity.

Local verification compared heat, cooling and duration with isolated original WASM arithmetic in 3,033 checks. Surface candidate generation passed 6,612 comparisons across 551 original native candidates. These probes isolate the relevant native functions and stub unrelated engine services; they do not run a rendered game. Additional checks cover ground-fire progression, generated-source consistency, output isolation and unchanged hashes of all three original inputs. There is no runtime integration or visual-game validation claim for the deferred fire feature.

## 简体中文

❌ 持续燃烧留待下个版本。`Burning.java` 与生成的 `FireCatalog.java` 是已准备的计算模块，本次 `CombatWorld` 尚未调用它们。角色/NPC 持续点燃、共享地面火生命周期和入水熄灭事务均未启用。当前运行路径保留已有的燃烧瓶几何命中处理与持续催泪瓦斯暴露，不能将其描述为完整原生火焰行为。

✅ 已只读核验受支持原引擎与元数据。`tools/fire_metadata.py` 固定引擎、`explosion.ymt`、`explosionfx.dat` 三份输入版本，生成 36 项爆炸到火焰的映射，不兼容输入明确失败。源码与可选报告共用输出保护，覆盖外部资源根目录、符号链接及输入硬链接；写出使用独立临时文件与原子替换。

已准备的算法包括：

- 原邻近扫描热量累积、冷却、扫描周期和首次随机延迟；原 PED 包围盒仅将 X/Y 缩至中央三分之一，保留 Z。
- 原点燃条件。当前资源没有独立的玩家点燃和忽略半径字段，两者原解析默认值均为假；普通爆炸仅能进入合格 NPC 的点燃分支，FIRE 伤害与 `DIR_FLAME` 另有原生特殊分支。
- 每秒 18.75 点的身体燃烧伤害，以及原默认持续时间：玩家邻近火焰两秒、玩家爆炸点燃七秒、NPC 十秒。七秒分支只是已核验计算能力，不代表当前普通爆炸已获得玩家点燃授权。
- 服务端种子的原随机算法、地面火候选点、向下两米检测、寿命/半径/燃料变化和显式熄灭。当前二进制把首个候选寿命覆盖为 20–25 秒并复用，FIRE 分支把后续点排在 Y/Z 平面；原生函数隔离执行已确认这些特定版本行为。

下版本需将上述算法接入服务端火焰身份、实体代次、租约、几何与遮挡结果，受限的原生水面/包围盒观测，权威点燃、扣血、熄灭事件，以及客户端视觉清理。候选点必须通过向下接触和来源到接触点的遮挡检查后才能成为有效火焰。客户端不能授权热量、伤害、时长、数量或位置。车辆残骸火焰布点及 NPC 原生任务相关的终结伤害分支也未完成；后者目前仅有独立条件函数，普通每秒扣血不等同于完整 NPC 任务行为。

本地隔离原 WASM 算术检查包含 3,033 项热量、冷却、时长对照；551 个原生地面火候选点通过 6,612 项比对。这些检查仅执行相关原生函数，其余引擎服务使用替身，不是实机画面验证。补充检查覆盖地面火变化、生成一致性、输出隔离及三份原输入哈希不变；不将本次准备工作表述为已接入运行流或已完成游戏内验证。

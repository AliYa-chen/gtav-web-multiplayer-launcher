# REA audit: resources and online-mode feasibility

[English](#english) | [简体中文](#简体中文) · [Implementation roadmap](online-mode-roadmap.md)

## English

**Audit date: 2026-10-10. Result: the current resources and bridge support a credible path toward a self-hosted shared open world with cloud-style entry, cooperative jobs and persistent progression. They do not establish compatibility with Rockstar services or that original Online scripts can run unchanged.** This is analysis and a development plan; no new game mode, cloud camera or database was implemented by this audit.

### Evidence and coverage

| Evidence | Observed result | Boundary |
| --- | --- | --- |
| REA 6.3.0, shipped JavaScript application analysis | Four JavaScript files parsed, 70,907 AST nodes, zero parse failures; worker, request and storage relationships retained | Whole-tree semantic extraction reached its 100,000-node ceiling; 14,951 semantic unknowns remain. Static graph traversal is not execution. |
| Focused REA analysis of a byte-identical `io_worker.js` copy outside the game directory | One file, 6,509 AST nodes; `gta5-userdata` IndexedDB and `/log` syntax are present | 1,400 unresolved semantics remain. A no-match semantic trace cannot establish that a feature is absent. |
| Original WASM format-aware audit | 91,111 functions: 85 imported and 91,026 defined; 86 import entries including memory; 22 export entries including a table | REA `open_binary` explicitly rejects this WASM format. WASM findings come from the project's read-only section/instruction parser, not a claimed Ghidra decompilation. |
| Native bridge verification | All 202 current export descriptors match the original name/type data and version-gated builder; 68 selected native bodies and 7 script-loading bodies decoded | Descriptors are interfaces, not 202 independent tested multiplayer features. No WASM instantiation or game execution in this audit. |
| Resource-directory audit | 1,528 manifest-listed top-level RPF directories decoded; 174,170 records including directories | 261 nested RPF entries were inventoried but not recursively inspected; counts include variants and duplicates. |
| YSC structure audit | 22 representative payloads decoded in memory; internal names, code/string pages and native-table bounds validated | No complete YSC instruction/control-flow decompilation and no runtime mission test. Neither source scripts nor extracted geometry are published. |

Original `gta5data/b/8b0b5899ed/game.wasm`: **63,201,802 bytes**, SHA-256 `11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0`. This identity is required for the function indices and layouts below. A different engine needs independent validation; version checks stay enabled.

REA evidence identifiers retained in the local finding ledger:

| Identifier | Meaning |
| --- | --- |
| `ev_eec4598e4a8c479663d70598f8f9edf64d54715a9865fc236ac9dbe253cc1e65` | Original build-directory JavaScript application graph |
| `ev_f9bccf49a5fee5d661a47fcb823fff7c317f86f182e8322ac5650b024490243c` | Summary reporting coverage and semantic limits |
| `ev_aa1a1d9e553edcd7bf32f0dd9ef3d4e2c33a220bb431249d6857bb53bb069713` | Focused byte-identical userdata-worker analysis |
| `ev_0f755ef847c92a28e52e29c5c9e761c5ca464ca12e4d70e0b13d414f0c28ee72` | Focused worker coverage summary |

Full REA graphs and parser evidence are kept in ignored `archive/rea-online-audit/`, not in the source distribution. The worker copy's SHA-256 is `d91c89e64f7f280666b5c9d1669ed6d65d66605077264569a49146ed79fe0bae`; `game.js` is `81a7d6e912238de3d89bcafb1b01450671c6793167babb0ec970f308f454bcf0`. Existing `io_worker.js:611–640` writes userdata records to browser IndexedDB; it does not provide authoritative accounts, inventory or server persistence. REA's generic endpoint extractor also labels a `get('list')` call in the GPU cache as an endpoint candidate; manual inspection identifies it as a cache operation, so it is not treated as a multiplayer service.

### Script packages: new findings that supersede the earlier directory-only limitation

| Package | Directory records | Actual YSC file entries | Interpretation |
| --- | ---: | ---: | --- |
| `script.rpf` | 1,027 | 1,026 | Explicitly mounted by the supplied `gta5.meta` |
| `script_rel.rpf` | 711 | 710 | Separate on-disk variant; these mount entries do not select it |
| `script_wasm.rpf` | 9 | 2 | `appcheats.ysc`, `cellphone_flashhand.ysc`; also 3 GFX, 3 YTD and the root record |

`common/data/levels/gta5/gta5.meta:397–406` mounts `script.rpf` and declares `script_wasm.rpf` an overlay. Nine records therefore do **not** mean nine multiplayer scripts. Other mount paths and execution order remain outside this bounded check.

The native `scrProgram` constructor, function **16924** at raw offset **9,958,554**, independently confirms code-page table `+16`, code length `+28`, native count `+44`, native table `+64`, name `+96`, string pages `+104` and string length `+112`; pages are 16 KiB. Representative samples have bounded pages and matching internal names. These are actual structure checks, not conclusions inferred solely from filenames.

| Selected entry in mounted `script.rpf` | Code bytes | Native-table entries | Candidate investigation |
| --- | ---: | ---: | --- |
| `freemode` | 10,348,901 | 2,971 | Free-mode lifecycle and dependencies |
| `fm_mission_controller` | 7,950,638 | 3,145 | Cooperative objective/state dependencies |
| `fm_race_controler` | 4,462,685 | 2,274 | Race presentation and stage structure |
| `fm_content_taxi_driver` | 1,427,859 | 1,148 | Taxi activity presentation |
| `gb_delivery` | 1,543,427 | 981 | Delivery activity presentation |
| `gb_casino_heist` | 3,936,698 | 1,801 | Complex interior/scene/mission dependencies |
| `emergencycall` | 3,933 | 41 | Small emergency-event candidate |

Native-table entries are neither executed-call counts nor supported-API counts. The separate `script_rel` freemode has only 1,439,924 code bytes: swapping same-named scripts across these packages is unsafe. Modern-looking names do not prove all associated DLC resources exist. The 5,819 effective manifest entries have no explicit `/dlcpacks/` paths, but nested contents are not fully covered.

### World data and reusable presentation

The decoded top-level directories contain 15,557 YBN collision, 5,853 YMAP placement, 977 YTYP archetype, 383 YND road, 4,404 YNV navigation, 10,748 YCD animation, 481 GFX UI and 465 CUT cutscene entries. This is an inventory, not verified full-map server coverage. Current exported collision/pedestrian navigation remains approximately **600 × 600 m** around the spawn area.

Structured files were parsed for 216 scenarios, 180 trigger rules across 59 event types, 240 pedestrian and 149 vehicle model sets, 115 population schedules, 298 vehicle definitions, 248 handling entries, 90 vehicle layouts, 91 weapon definitions, 82 pickup definitions and 12 dispatch response types. These can inform bounded server rules and client projection, but do not implement ownership, mission rewards or common incident identity. All clients independently replaying local dispatch would duplicate responders.

### Native interfaces worth adding to the isolated adapter

All indices below refer to the exact WASM hash above and are **not currently exported by the project bridge**. They are not script native hashes or portable function addresses.

| Capability | Function index | Observed body / remaining work |
| --- | ---: | --- |
| Animated vehicle entry | 60571 | Creates `CTaskEnterVehicle`; still needs model, seat and script-task lifecycle validation |
| On-foot escort / navigation | 60582 / 60600 | Builds entity-follow / NavMesh movement tasks and calls scripted-task admission |
| Task sequences / status | 60637, 60638, 60641, 60647 | Script-handler resources and status; local status is not proof of server objective completion |
| Vehicle escort | 60697 | Vehicle references, locks and control task; only the active simulation owner may apply it |
| Ambient interactions | 60759 / 60760 | Scenario-name lookup and tasks; shared scene occupancy must be server-owned |
| Race checkpoints | 50519 / 50530 | Script-handler checkpoint resource with paired cleanup |
| Props / pickups | 56466 / 56475 | Model and network-handler branches require controlled local projection; collection/reward remains a server decision |
| Doors / interiors / IPL | 56530 / 52614 / 60338 | Door events, interior proxies and streaming requests; readiness and teardown are not established by calling the request |

The current bridge already supports enough entity, vehicle, pose, combat, animation and marker primitives to start **original** race, courier and wave-defense modes. Add escort, props, shared doors and interiors after verifying each ABI, owner scope, script context and cleanup path. Never accept client-selected function indices or arbitrary YSC/JavaScript commands over the wire.

### Cloud loading and cinematic entry: additional verified evidence

`Clouds.xml` defines **20 cloud sets and 111 layer references**. `v_clouds.rpf` contains **62 YDR, 17 YTD and 1 YTYP**; all 80 payloads were decompressed in memory (29,474,816 decoded bytes). Layer names match drawables after case normalization, with 12 distinct casing differences. Mesh/texture rendering and runtime name resolution were not tested. Archive SHA-256: `9d2e72640adedd77096f2ec8639996055746a9b5b24f236efbf1dde64180407e`.

The additional camera audit fully decoded 36 command bodies plus 15 related callees. Only fade-in (49036) and faded-out query (49034) are in the current adapter; 34 selected commands still need verified exports.

| Candidate | Function indices | Required boundary |
| --- | --- | --- |
| Create/render/destroy/activate script camera | 48924 / 48922 / 48928 / 48931 | Valid current script handler, camera ownership and paired cleanup |
| Camera position/rotation/FOV/interpolation | 48944 / 48945 / 48946 / 48999 | Audited vector ABI, owned handles; setters can cancel interpolation |
| Cloud preload/load/unload/alpha | 52830 / 52831 / 52832 / 52834 | Existing named cloud set, layer readiness and restoration of shared visual state |
| Destination focus and scene readiness | 60364 / 60363 / 60377–60380 | Scene/thread ownership; requests do not prove loading complete |
| Original player switch | 60382 / 60403 / 60385 | Research only; not a cosmetic-only entry primitive |

`CPlayerSwitchMgrLong::SetState` (**47687**, raw offset **30,576,430**, **6,442 bytes**) contains branched direct calls to dispatch flush, vehicle removal and pedestrian/vehicle population refill, as well as scene-loading and camera changes. Not every call runs on every transition; the observed side effects are enough to rule out treating original player-switch as a harmless cloud animation.

The existing GPU `world` signal uses more than 300 draw calls and then 1.5 seconds without skipped compiling-pipeline draws **or a 60-second deadline** (`wgpu_worker.js:2716–2730`). It is a rendering heuristic with a timeout fallback, not proof of server snapshot, character placement or destination collision. `client/index.html` currently removes its title overlay at that rendering stage. Future entry must preserve the existing native mutation gate and add separate spawn/character/streaming barriers.

Proposed sequence: own pre-engine loading visual → engine-ready owned camera/cloud transition → matching world epoch and character/scene/collision ready → descent → restore camera/focus/input once. Every stage needs timeout, cancellation, stale-attempt rejection and reconnect handling. This audit does not implement or visually validate the sequence.

### What currently prevents unchanged GTA Online

The original `netSocket` bind/send/receive gaps were reconfirmed from instructions: `NativeBind` (185) sets its handle to `-1`; `Send` (13571) lacks real I/O calls; `Receive` (13829) retains a fixed failure/skip path. Real clone handlers and synchronization-tree serializers still exist, but depend on valid players, objects, sessions, virtual calls and script resources. Current bridge exports expose read-only tree/handler readiness, not native clone transport.

The shipped JavaScript socket layer constructs binary WebSocket traffic, while this project uses its own structured WSS protocol. A Redis installation, container, new IP or forced “online” flag cannot translate the original session protocol or satisfy those prerequisites. Keep `native_clone_transport=false` and `game_sync=false` until the corresponding runtime evidence exists.

The current server is one in-memory `PUBLIC` session, hard-limited to eight players and 256 entities, with 50 ms maintenance. It owns accepted world identity and rules, while authorized clients still simulate native movement and vehicle physics. Weapon selection is not inventory ownership, lease-reported vehicle health is not complete authoritative vehicle damage, and a recent-64-request cache is not a durable reward ledger. See the [roadmap](online-mode-roadmap.md) for PostgreSQL, Redis, containers and milestones.

### Remaining questions and acceptance

- Decode selected YSC instruction/control flow and resolve native identities before claiming an original task's behavior or dependencies.
- Verify native cloud/camera, door, object and scene operations in the correct engine context with two clients, cancellation and ownership handover.
- Expand collision/navigation exports and measure actual tick cost, queues, bandwidth and client frame rate before increasing player limits.
- Add accounts, character leases and durable idempotent inventory/reward transactions before persistent progression.
- All resource analysis remains read-only; extracted geometry, scripts, original engine bytes and decoding material stay outside Git. Static evidence does not replace in-game acceptance.

## 简体中文

**2026-10-10 审计结论：当前资源和同步桥足以支持逐步实现“看云入局、共同开放世界、合作活动和永久成长”的自建多人模式；尚不能证明原 GTA Online 脚本可原样运行，也不兼容官方服务。** 本轮交付是资源分析和实施路线，不把尚未实现的云端镜头、任务或数据库记作完成。

### 方法与覆盖范围

- REA 6.3.0 静态分析原构建目录的四个 JS 文件，访问 70,907 个 AST 节点，无解析失败。整体语义图触及 100,000 节点上限，仍有 14,951 项未知；不能把局部图当作完整运行证明。
- 针对与原文件字节一致的 `io_worker.js` 隔离副本再次分析：6,509 个 AST 节点，仍有 1,400 项语义未知。REA 识别到 `gta5-userdata` IndexedDB，实际源码确认其保存浏览器用户文件；它不是服务端账号或资产数据库。GPU 缓存中的 `get('list')` 被泛化识别为 endpoint 候选，经人工核对属于缓存操作，不作为联机接口证据。
- REA 明确不支持直接打开此 WASM，原生结论由项目只读解析器补充：91,111 个函数，其中 85 个导入函数；86 个全部导入项包含内存。22 个原始导出项包含函数和表。不能把它写成已用 Ghidra 反编译整个游戏。
- 当前引擎描述的 202 个接口全部与原始 name/type 节及版本校验构建器一致；完整解码 68 个目标原生函数和 7 个脚本加载函数。接口数不等于已验证的多人功能数。
- 解析 1,528 个顶层 RPF 目录，174,170 条记录包含目录；261 个嵌套 RPF 未递归分析。对 22 个代表 YSC 在内存中解码并验证结构，没有完整反编译 YSC 控制流，也没有运行游戏。

原始 `game.wasm` 为 **63,201,802 字节**，SHA-256 为 `11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0`。以上索引和布局只对该身份有效。英文部分列有 REA Evidence ID；完整证据保存在忽略提交的 `archive/rea-online-audit/`。

### 脚本的新证据

此前文档仅检查加密包头，本轮进一步解析目录：`script.rpf` 的 1,027 条记录实际包含 **1,026 个 YSC**；`script_rel.rpf` 为 **710 个 YSC**；`script_wasm.rpf` 的 9 条记录实际为 **2 个 YSC、3 个 GFX、3 个 YTD 和根目录**。两个 YSC 是 `appcheats` 与 `cellphone_flashhand`，不能称作九个线上脚本。

`gta5.meta:397–406` 明确挂载 `script.rpf`，并把 `script_wasm.rpf` 标为覆盖层；同处磁盘的 `script_rel.rpf` 并非这些挂载项选择的版本。原引擎 `scrProgram` 构造器 16924 独立确认脚本头的代码页、native 表、内部名称和字符串页布局，分页为 16 KiB；22 个样本的范围和内部名称均吻合。

已验证的任务候选包括 `freemode`、`fm_mission_controller`、`fm_race_controler`、`fm_content_taxi_driver`、`gb_delivery`、`gb_casino_heist` 和 `emergencycall`。当前挂载版 freemode 有 **10,348,901 代码字节、2,971 项 native 表**，另一 rel 版本只有 1,439,924 代码字节。名称相同不代表版本、依赖或行为相同；native 表项也不等于可用接口或执行次数。

任务名字能确定后续研究目标，不能证明玩法已移植、对应 DLC 内容齐全或可安全启动。清单没有显式 `/dlcpacks/` 路径，但嵌套资源未完整覆盖，不能因此断言没有 DLC 内容。

### 可以继续复用什么

资源目录包含 15,557 项碰撞、5,853 项地图放置、977 项原型、383 项道路、4,404 项导航、10,748 项动画、481 项 UI 与 465 项过场资源。数量包含重复和变体，不能当作“服务端已有全地图物理”。当前实际导出碰撞/行人导航仍约出生区 **600×600 米**。

已解析的结构化配置包括 216 个场景、180 条触发规则、59 类事件、240 组行人模型、149 组载具模型、115 个人口时段、298 种载具定义、248 项操控配置、90 项载具布局、91 种武器定义、82 项拾取定义和 12 类调度响应。适合转成有界服务端规则和表现配置，但拾取表不是背包，调度表也不能直接让每个客户端各生成一队警察。

新增原生接口候选及索引见英文表：上车动画、步行/车辆护送、NavMesh 行走、任务序列与状态、环境互动、竞速检查点、物件/拾取、门和室内。函数体已确认存在，但这些候选尚未由当前桥导出；每个都需要独立验证 ABI、脚本上下文、实体租约、资源 ready 和清理。服务端负责活动实例、目标、期限与奖励，客户端只提交意图和呈现确认结果。

### 看云加载的具体证据

`Clouds.xml` 有 **20 套云配置、111 个层引用**；`v_clouds.rpf` 有 **62 个 YDR、17 个 YTD、1 个 YTYP**，80 个资源块均在内存中解压成功，合计 29,474,816 字节。引用名经大小写归一后均找到模型，其中 12 个名称存在大小写差异；尚未验证实际运行时解析、网格/纹理画面或渲染效果。

新增镜头审计完整解析 **36 个命令和 15 个相关函数体**。当前桥只导出了其中的淡入和淡出状态查询，另外 34 个仍需版本化适配。专用相机、云层、落点焦点及流送接口的具体索引和约束见英文表，不能照网上 native 名称直接调用。

原玩家切换状态函数 **47687** 的分支中确有清空调度、移除载具、重填行人/车辆人口以及修改场景加载的调用。因此，推荐独立的入局相机和真实云层方案，不在公共战局直接重放原始角色切换流程。GPU `world` 信号也有 **60 秒截止兜底**，它仅为渲染启发式，不能单独代表角色、快照或碰撞就绪。

目标流程为：启动器前期加载画面 → 引擎就绪后取得本次入局专用相机/云层 → 核对 world epoch、角色、场景和碰撞 → 镜头下降 → 成对恢复相机、焦点和控制；所有阶段均可超时、取消、重连，并拒绝旧尝试回调。此流程尚未实现，静态分析不能标为看云效果已验收。

### 为什么还不能原样启动官方线上模式

原始 `netSocket` 绑定、发送和接收缺口仍然存在：绑定把句柄写为 `-1`，发送没有真实 I/O，接收保留固定失败分支。clone 和同步树函数有实际代码，但要求网络玩家、对象、会话和脚本资源完整初始化；当前只有部分只读就绪观察，没有原生 clone 传输。浏览器胶水的二进制 WebSocket 与本项目 WSS 协议也不同。

因此，容器、Redis、替换服务器地址或强制 online 标志都不能自动补齐原网络协议和物理。现实方向是实现相近的体验与玩法闭环：自有战局生命周期、共享实体、合作任务、账号、背包、车库和持久结算。`native_clone_transport` 与 `game_sync` 仍保持 false。

当前服务端为单进程、单 PUBLIC 战局、最多 8 人和 256 实体，维护周期 50 毫秒；原生移动/车辆物理仍由有租约客户端执行。武器选择不等于拥有权，客户端报告的载具血量不等于完整权威受损，最近 64 个请求缓存也不是永久奖励账本。基础设施与玩法实施顺序见[完整路线图](online-mode-roadmap.md#简体中文)。

### 仍待验证

YSC 指令与 native 身份映射、云端镜头/场景/门/物件的真实运行、全地图碰撞导航、实际人数压力、账号与持久幂等事务均有独立验收门槛。原始资源保持只读，游戏脚本、几何、原引擎和解码材料不提交。无法从静态分析承诺与官方线上模式完全一致。

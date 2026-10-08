# FiveM 参考与浏览器实现边界

研究日期：2026-10-08（上海时间）。公开源码固定于 [citizenfx/fivem 提交 `a74c2ccf0a56546dbb591b4545c643f56acebd3d`](https://github.com/citizenfx/fivem/commit/a74c2ccf0a56546dbb591b4545c643f56acebd3d)，提交时间为 2026-10-07。本文检查了该提交的完整文件目录和下列实现；官网与文档是研究时的公开页面，可能随后更新。本次没有复制 FiveM 源码到产品、运行 FiveM、访问官方游戏账号或改变现有 Java 服务。

## 结论与建议

FiveM 值得参考的是它对“启动会话、界面、实体复制、服务器可见范围和所有权”分别建立适配层的做法。它不是一个只接收位置的大厅，也不是把原 GTA Online 的在线标志改成 true。FiveM 客户端修改 PC GTA 的运行路径，复用其网络对象、同步树和渲染／脚本能力；FXServer 解析实体同步数据并管理对象身份、路由和归属。

本项目适合继续使用轻量 Java 作为统一世界协调者，同时在 WASM 内建立经过验证的引擎适配层。浏览器界面和原生暂停菜单可以接入同一自有会话状态，但原生网络状态、ROS 凭据和网络脚本 handler 必须保持真实。仅为界面营造在线战局体验时，应称为“浏览器公共战局”，不能因此宣称恢复了 GTA Online 或兼容 FiveM。

官网 [FiveM](https://fivem.net/) 描述的是 PC GTA V 修改框架，并列出 Windows 与 GTA V Legacy／Enhanced 的产品要求。[仓库 README](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/README.md) 说明自定义模式和 FXServer。本文只核对被引用的源码路径，没有证明本 WASM 与任何 PC 构建的内存布局或二进制协议兼容。

## 实体同步：可以借设计，不能移植地址

### 客户端原生 clone 与同步树

核心证据是 [`code/components/gta-net-five/src/CloneManager.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/gta-net-five/src/CloneManager.cpp)。它维护创建、同步、删除确认，以及对象 ID 和 `uniqifier`，用这些信息避免删除后旧包命中被复用的对象。`HandleCloneCreate` 的真实步骤包括：

1. 检查待删除确认、已有对象及重复身份。
2. 按实体类型取得 `netSyncTree`，从 bit buffer 读取创建状态。
3. 创建 RAGE clone object，检查 `CanApplyToObject`，关联同步树，再应用／注册对象。
4. 返回创建 ACK，并把对象扩展状态关联到 `entity:<id>` StateBag。

这比“创建一个 NPC 然后不断瞬移”能表达更多引擎状态，也说明模型加载、对象创建、同步树可应用与网络身份确认属于不同步骤。浏览器可借用相同的生命周期分层、创建确认、版本隔离和资源 ready 门槛；本项目的 `entity_id/generation/owner_epoch` 是自有协议，不应改名后假装对应 FiveM 的 ID 和 `uniqifier`。

[`code/components/gta-net-five/src/CloneExperiments.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/gta-net-five/src/CloneExperiments.cpp) 在 `ONESYNC_CLONING_NATIVES` 条件下提供 `EXPERIMENTAL_SAVE_CLONE_CREATE/SYNC` 与 `EXPERIMENTAL_LOAD_CLONE_CREATE/SYNC`。实现仍依赖有效的实体 guid、`netObject`、`GetSyncTree`、`WriteTreeCfx/ReadFromBuffer`、`CreateCloneObject` 及 network object manager。这里的实验接口不是独立 JavaScript 序列化库，未初始化网络对象时不能仅导出函数就使用。

多个文件使用 `hook::get_pattern`、MinHook、Windows x64 调用约定和随游戏 build 改变的偏移。这些字节模式、C++ 对象指针及 vtable 布局不能用于 WASM。WASM 分析应继续基于当前固定构建的函数索引、真实 type 节 ABI、内存范围和有效脚本上下文，保持独立实验副本与可回退路径。

### 服务器实体、可见范围和控制迁移

[`code/components/citizen-server-impl/src/state/ServerGameState.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/src/state/ServerGameState.cpp) 可以直接核对 `ProcessCloneCreate/Sync/Remove/Takeover`、`ProcessClonePacket` 和 `ReassignEntityInner`：

- 接收对象类型、对象 ID、`uniqifier`、创建 token 和同步节点数据；对创建／同步／删除分别 ACK。
- 将客户端上报的同步数据解析进服务端同步树；不把任意发包者当作当前所有者。
- 依据玩家 focus、距离、世界格网及 routing bucket 计算实体是否相关；车辆乘客与列车关联部分有专门依赖逻辑。
- 对出 scope、断线或需重分配的对象裁决新 owner，并更新 StateBag 的 owning peer。
- 在该版本的特定迁移路径中允许原 owner 在迁移后短时间内提供数据。那是其协议与同步状态的设计，不适合照搬到本项目的严格 `owner_epoch` 隔离规则。

可借鉴的重点是：服务器保存完整实体身份与生命周期；可见范围不是客户端任意订阅；控制迁移是对象状态变化；主车、乘客与附件必须协调；旧包与重复创建必须被明确处理。[`ServerGameState.h`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/include/state/ServerGameState.h) 给出了实体及客户端同步状态的数据结构。[`OneSyncVars.h`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-server-impl/include/OneSyncVars.h) 还明确区分 OneSync 开关／模式及实体 lockdown 策略。

公开 [OneSync 文档](https://docs.fivem.net/docs/scripting-reference/onesync/) 解释了同步节点、focus zone、迁移和服务器创建实体。文档提及默认 424 单位范围，但源码还允许实体／玩家范围策略；它不是本项目必须采用的常数，也不能据此推断服务器在独立运行完整 GTA AI 与车辆物理。服务器创建并持久登记对象和由客户端引擎执行仿真，是两种需要分别核实的能力。

### StateBag 与本项目组件

[`code/components/citizen-resources-core/src/StateBagComponent.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/citizen-resources-core/src/StateBagComponent.cpp) 维护 keyed state、routing targets、owning peer 与变更传播，接收路径检查数据来源与 owning peer。它适合启发低频实体元数据和脚本属性分发，而不是成为允许任意玩家写生命值和座位的无类型字典。

本项目已经有严格类型化组件与服务器战斗规则，应保持这种约束：位置和表现由有效租约提议；血量、所有者、座位、创建和删除仍是服务端事务。参考 StateBag 时可以借 routing 和变更观察接口，不必复制它的 wire format，也不应因为公开实现有某段宽松策略就移除本项目已有校验。

## 连接、心跳与世界初始化

[`code/components/net/src/NetLibrary.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/net/src/NetLibrary.cpp) 区分初始化、内容下载、信息获取、连接、活动与断线状态。`RunFrame` 明确处理各阶段进度、连接重试和活动连接超时。收到连接成功与游戏已加载也不是同一事件。

[`code/components/net/src/NetLibraryImplV2.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/net/src/NetLibraryImplV2.cpp) 使用 ENet，分别发送可靠／非可靠包，维护 keepalive 和连接超时。该文件证明该实现路径并非普通浏览器 WebSocket；它不是跨平台可直接导入的网络模块，也不表示当前产品所有构建始终选择这个历史实现版本。

浏览器第一阶段继续用现有 WebSocket 没有架构障碍。更重要的是区分：传输存活、应用心跳、引擎可执行、模型已加载、世界基线已安装、实体租约已激活。即使将来增加 WebRTC，也需要这些状态和裁决规则；WebRTC 不会恢复 RAGE 同步树、原网络身份或自动完成地图流式加载。

本项目应把网络连接成功后的启动分为：能力／构建确认 → 世界快照 → 引擎加载 → 本地角色 ready → 区域实体资源 ready → 允许控制。重连恢复角色与世界基线时不重新创建一份玩家身份；尚未 ready 的模型仍保存逻辑实体，不因加载延迟让服务器删除对象。

## FiveM 主菜单、NUI 与原生暂停菜单不是一个系统

### 自有入口与游戏加载桥

[`code/components/glue/src/ConnectToNative.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/glue/src/ConnectToNative.cpp) 使用自己的 `mpMenu` NUI frame，绑定 `connectTo`、断开／重连及连接进度／失败消息。[`BindNetLibrary.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/glue/src/BindNetLibrary.cpp) 在连接进入 `CS_ACTIVE` 后驱动 `LoadGameFirstLaunch` 或 `ReloadGame`；游戏请求加载时关闭主 UI、销毁 `mpMenu` 并切换到服务器上下文。

这是“自有客户端模式状态与原游戏加载生命周期相接”的具体例子。它没有证明官方 GTA Online 入口直接理解 FXServer。浏览器可以采用同类 seam：主页／暂停战局菜单发明确的自有连接命令；网络层确认后切换沙盒战局生命周期；退出时撤销输入、实体桥和 UI 上下文，而不是单纯跳转 URL 或全局欺骗 online native。

### NUI 是 CEF 资源界面

[`code/components/nui-resources/src/ResourceUI.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/nui-resources/src/ResourceUI.cpp) 根据资源的 `ui_page` 创建／预载 UI frame，关联 scheme 和资源生命周期。[`ResourceUIScripting.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/nui-resources/src/ResourceUIScripting.cpp) 提供 JSON 消息、焦点、鼠标和 keep-input 管理；停止资源时撤销焦点并销毁界面。[`NUICallbacks_Frame.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/nui-core/src/NUICallbacks_Frame.cpp) 在 CEF V8 上下文里处理 frame 创建和销毁回调。

[`GtaNui.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/glue/src/GtaNui.cpp) 将 UI 纹理／渲染和 Windows 输入钩子接到游戏。它依赖 PC 渲染设备、纹理与窗口消息，不能复制到 WebGPU WASM。浏览器已经有页面渲染和 Worker 消息通道，不需要再嵌入 CEF；应借其焦点与生命周期规则，自行控制 pointer lock、菜单输入和游戏控制状态。

### 原生暂停菜单是 RAGE 前端资源和上下文

[`data/client/citizen/common/data/ui/pausemenu.xml`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/data/client/citizen/common/data/ui/pausemenu.xml) 包含 `FE_MENU_VERSION_SP_PAUSE/MP_PAUSE`、`InSP/InMP` context、对应头部以及多人 lobby／角色选择等结构。这说明菜单资源描述了界面；它没有建立玩家、同步树或服务器会话。

[`PatchPauseMenuBuilds.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/gta-core-five/src/PatchPauseMenuBuilds.cpp) 包装原生暂停上下文激活，并加入请求游戏 build 对应的 context；实现使用 PC 字节模式和调用 hook。[`GameInit.cpp`](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/code/components/gta-core-five/src/GameInit.cpp) 还提前初始化多人 gamer-info／文字聊天资源，并处理加载与断线事件，说明菜单可用性包含资源预载和运行时条件。

因此，要在本项目中显示原生“战局”菜单，应先验证当前 WASM 的具体前端版本、context、文字资源和数据填充入口。仅替换 XML 标签或把 `NetworkIsGameInProgress` 固定为 true，可能把缺少 player manager、网络脚本上下文的程序送进不安全分支。

## 当前 WASM 可实验的接入点

本次额外使用项目内 `WasmAudit` 只读核对了下列原生入口。它们是当前构建的函数索引和真实 ABI，尚未因本文而导出或执行：

| 索引 | name 节名称 | ABI／用途 |
| ---: | --- | --- |
| 51830 | `hud_commands::CommandRestartFrontEndMenu(int,int)` | `(i32,i32) → void`；当前未查清菜单版本枚举和重启条件 |
| 51835 | `hud_commands::CommandSetPauseMenuActive(bool)` | `(i32) → void` |
| 51840 | `hud_commands::CommandIsPauseMenuActive()` | `() → i32` |
| 51845 | `hud_commands::CommandPauseMenuActivateContext(int)` | `(i32) → void`；context 标识需单独验证 |
| 51856 | `hud_commands::CommandIsFrontendReadyForControl()` | `() → i32` |
| 51857／51858 | `CommandTakeControlOfFrontend`／`CommandReleaseControlOfFrontend` | `() → void`；需要正确成对生命周期 |
| 54706／54708 | `CommandNetworkIsGameInProgress`／`CommandNetworkIsSessionStarted` | `() → i32`；真实网络状态，不能当自有在线标记 |

当前 name 节没有精确名称 `ActivateFrontendMenu`，不能照网上同名 native 文档盲目套调用。项目探针已定位 ped／player 同步树和网络 handler 的只读观察入口，但本地现有记录出现过三项未初始化。观察返回指针是否在内存范围内，只是早期 ready 指标，不证明对象、节点和应用路径完整可用。

原 socket 发送／接收适配缺失、会话访问条件和脚本 handler 依赖的具体证据仍见 [原线上模式审计](原线上模式审计.md) 与 [角色同步接口审计](角色同步接口审计.md)。FiveM 的 PC hooks 无法消除本构建里的这些条件。

## 建议的浏览器实现分层

| 接入层 | 可落实的实现 | 必须保持的界限 |
| --- | --- | --- |
| 自有在线生命周期 | 明确 `offline/connecting/loading/active/reconnecting/leaving`，绑定 Java world epoch、身份和 generation | 不改变官方网络／ROS 判断的语义 |
| 引擎生命周期 | 在有效脚本线程执行角色、实体、控制恢复；初始化和退出按阶段确认 | 不从页面 WS 回调直接调 C++ 对象或伪造 handler 指针 |
| 原生菜单实验 | 校验前端 ready、加载本构建资源、激活已验证 context、显示自有战局摘要 | 上线菜单不能顺带调用未经恢复的原线上脚本流程 |
| 页面界面 | 沿用现有浏览器，不引入 CEF；发送固定菜单命令，统一输入与焦点管理 | DOM 菜单不能被描述为已实现 RAGE 原生菜单 |
| 世界复制 | Registry 的 ID、快照、epoch、租约与依赖集合；适配器按组件写原生实体 | Java 协调不等于完整 GTA 物理权威 |
| 原同步树研究 | 先取得有效本地 netObject，再验证创建数据、应用、更新与迁移 | 不直接加载 FiveM bitstream 或宣布协议兼容 |

下一步最有价值的是一个可回退的原生前端实验：正常公共战局已进入后，在已确认的脚本上下文检查前端 ready；使用隔离副本打开固定菜单；只填充“公共战局、玩家名单、返回游戏、退出战局”等自有数据；关闭后恢复输入；网络重连期间游戏和心跳继续。若资源或上下文不就绪，应回退到页面菜单并保留错误证据，不强行启用全部 Online 判断。

验收应观察真实游戏：菜单显示／关闭、多次打开、断线重连、玩家死亡重生以及切换单人均不留下输入锁或重复实体。原同步树实验另行验收；“菜单像线上”与“引擎已进入原生网络会话”必须分别报告。

## 许可与复用边界

固定提交的根 [LICENSE](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/LICENSE) 说明默认使用受 Rockstar Games Creator Platform License Agreement 及其引用条款约束；它列出的 `code/components/citizen-*/`、若干 client／tools 目录等例外文件，采用 **GNU Library General Public License version 2**。不能把整个仓库概括为 MIT，也不能因仓库包含 `LICENSES/LGPL-2.1.txt` 就把所有文件认定为 LGPL 2.1。

本文引用的服务端 `citizen-server-impl`、StateBag 的 `citizen-resources-core` 位于根许可列出的例外目录；`gta-net-five`、`gta-core-five`、`glue`、`nui-*` 和菜单数据不在该通配例外范围中，仍须检查根协议与每文件／第三方条款。根 [THIRD_PARTY_NOTICES.md](https://github.com/citizenfx/fivem/blob/a74c2ccf0a56546dbb591b4545c643f56acebd3d/THIRD_PARTY_NOTICES.md) 又列出 ENet、CEF 周边／依赖、RageLib、脚本 hook 等各自许可和通知，不能统一改写成本项目许可。

当前只参考公开架构并用自己的代码实现，没有导入代码、复制菜单 XML、图像、商标或分发 FiveM 二进制。因此本文不改写项目许可证，也不把上游条款附着到原有自有代码。以后如果直接复用或改编源码，应针对实际文件核对适用许可，保留版权和许可通知；对 GNU Library GPL 部分履行对应源码、修改说明及适用链接／可替换性义务；对第三方依赖保留其独立要求；对默认协议覆盖部分先确认允许的使用和分发范围。这些判断须以实际复用方式和固定版本条款为准，不能由“放进私有仓库”或“改成 Java”自动豁免。

FiveM／GTA 兼容性、游戏资源授权与商标也不是阅读源码便取得的许可。UI 应使用本项目自己的公共战局标识，不能让用户误认为是 FiveM 客户端或官方 GTA Online。

## 本次产物与复核

本次只新增本文档；所读取的公开源码留在忽略目录 `archive/cache/fivem-reference/` 作研究缓存，没有参与服务端构建。公开文件链接均固定到上述提交。目录树由 GitHub Git Trees API 取得，记录 `truncated: false`、15433 条目录项；少数 raw 请求失败后改用同一提交 tree 对应的 Git blob 获取，未混用其它版本。

以上结论来自实际读到的函数和调用链，不把函数名、官网描述或网络菜单字样单独作为“可以运行”的证明。本次没有验证原生菜单运行，也没有恢复原 RAGE／FiveM 网络协议。

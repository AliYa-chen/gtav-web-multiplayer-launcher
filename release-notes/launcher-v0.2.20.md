## English

**Category: Launcher · Version: 0.2.20**

### Changes

- Fix repeated online loading after selecting a local weapon that is absent from the server inventory, including Railgun. Equipment, reload and pose gameplay refusals retain the active socket and world baseline. Actual protocol incompatibilities still fail explicitly.
- Restore the authoritative weapon with bounded asset requests and equip retries. Native loading results of zero or temporary unarmed do not become new inventory selections; an intentional switch to another owned weapon remains possible. State and shot sampling suppress unowned native weapons without granting them to the session. Pending valid selections survive temporary zero results, and local acknowledgement tokens prevent an older refusal from cancelling a newer selection; no new server wire field is added.
- Map NPC effective health one-to-one above the original native dying threshold published by server 0.4.8. Preserve the final live threshold unit, exact environmental-damage candidates and server-confirmed death; player health behavior is unchanged.
- Label geometry-waiting shot logs as pending rather than a final miss; the authoritative damage event still determines health loss.
- Fix NPC action proposals accidentally echoing snapshot bone poses in the action view, which caused server rejection and stale hit geometry. The separate pose channel retains lifecycle validation. Omit degenerate optional native bounds while assets are loading; explicit invalid bounds remain rejected.

### Compatibility and validation

Use launcher 0.2.20 with server 0.4.8 for the NPC health mapping. This patch adds no Railgun entitlement and no new NPC armour. Existing original-engine version checks and isolated managed runtime generation remain in force; original resources stay read-only. Existing world collision/navigation data needs no replacement.

Local checks cover connection retention after gameplay refusals, asynchronous weapon selection and retries, pending-shot ammunition, reload cancellation/recovery, NPC native-health boundaries, pose/view validation and a real Java WebSocket NPC-damage flow. Resource and output-isolation regressions pass, with original input hashes unchanged. These checks do not establish rendered game behavior. macOS remains development/ad hoc signed and is not notarized. Remaining P0 scope is unchanged in the [next-release plan](../docs/p0-next-release.md).

## 简体中文

**分类：启动器 · 版本：0.2.20**

### 更新内容

- 修复选择服务端库存中未持有的本地武器（包括电磁枪）后反复显示在线加载页的问题。普通装备、换弹和姿态拒绝保留当前连接与世界基线；真实协议不兼容仍明确失败。
- 用有限的资源请求和装备重试恢复当前服务端武器。原生加载中返回零或暂时空手不会被当成新库存选择，主动切换另一把已持有武器仍可进行。状态和射击采样不再发送未持有本地武器，不授予其战局使用权。待确认的合法选择跨暂时零值保留，本地确认标识避免旧拒绝撤销新选择，不新增服务端网络字段。
- 按服务端 0.4.8 提供的原生死亡阈值逐点投影 NPC 有效生命，保留阈值边界最后一点存活生命、准确的环境伤害候选及服务端确认的死亡；玩家生命行为不变。
- 将等待几何确认的射击日志标记为待处理，避免被误读为最终未命中；实际扣血仍由权威伤害事件确定。
- 修复 NPC 动作 view 夹带快照骨骼姿态、导致服务端拒绝更新和命中几何过期的问题。姿态保留独立通道与生命周期校验。加载期间省略退化的可选原生包围盒，显式无效包围盒仍拒绝。

### 兼容与验证

NPC 生命换算配套启动器 0.2.20 与服务端 0.4.8 使用。此次不授予电磁枪，也不增加 NPC 护甲。保留原引擎版本校验和隔离运行副本生成；玩家原资源保持只读，无需更换既有碰撞/导航数据。

本地检查覆盖普通拒绝后保持连接、异步武器选择与退避重试、待确认射击扣弹、换弹取消/恢复、NPC 原生命边界、姿态/view 校验及真实 Java WebSocket NPC 伤害联调。资源/输出隔离回归通过，原始输入哈希未变；这些检查不宣称完成游戏画面验证。macOS 仍为开发/ad hoc 签名、尚未公证。剩余 P0 范围继续列于[下版本计划](../docs/p0-next-release.md#简体中文)。

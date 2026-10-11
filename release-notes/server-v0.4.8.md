## English

**Category: Server · Version: 0.4.8-world-experimental**

### Changes

- Fix NPCs incorrectly receiving a universal 200-point damage budget. Generate scalar health rules for the ten supported PED models from pinned original model, personality and health metadata. Effective health is `initialHealth - dyingThreshold + 1`, preserving the original strictly-below-threshold fatal condition.
- Ambient male Business pedestrians now have 76 effective points from native health 175 / threshold 100: three confirmed close-range 26-point pistol torso hits kill, instead of the earlier eight. Police use their original 101 effective points; NPC armour stays zero and player maximum health remains 200.
- Publish the native threshold only for NPC PEDs, for exact launcher 0.2.20 health projection. Environmental candidates preserve the model's authoritative maximum instead of reintroducing the old 200-point cap. Vehicle/object combat records do not use NPC health metadata.
- Add bounded pose diagnostic counters by rejection category and counts of conservative shot blocks due to unavailable target pose. Invalid pose updates retain previously accepted geometry. Fresh validated poses, ownership/lifecycle fences, exact original parts and obstruction confirmation remain required for damage.

### Compatibility and validation

Pair with launcher 0.2.20, which fixes rejected NPC view updates and unowned weapon selection reconnects. Existing required action/equipment/PED-pose capabilities and supported engine/resource hashes remain unchanged. Ordinary JAR updates preserve independently generated PED/vehicle geometry, collision maps and navigation; no geometry regeneration is required by this patch.

Java 17 compilation and 802 server regression checks pass, including original NPC health budgets, threshold equality, player health, vehicle/object snapshots, malformed/stale pose retention, history/ownership/lifecycle fencing, helmets and explosions. The health generator consistency check, output isolation and original input hash checks pass. A real Java WebSocket integration confirms accepted fresh NPC poses and server-owned pistol damage. These source/protocol checks do not claim rendered native-equivalent gameplay. Deferred P0 scope is unchanged in the [next-release plan](../docs/p0-next-release.md).

## 简体中文

**分类：服务端 · 版本：0.4.8-world-experimental**

### 更新内容

- 修复 NPC 统一获得 200 点可受伤生命的问题。按固定哈希的原模型、个性和生命元数据生成十种受支持角色的标量规则；有效生命为 `初始生命 - 死亡阈值 + 1`，保留原版严格低于阈值才终结的边界。
- 环境男性 Business 行人由原生命 175 / 阈值 100 得到 76 点有效生命；三发确认无遮挡的近距离手枪躯干命中（每发 26 点）即可击杀，此前需八发。警员按原配置为 101 点，NPC 护甲仍为 0，玩家生命上限保持 200。
- 原生死亡阈值仅发给 NPC PED，供启动器 0.2.20 逐点投影；环境伤害候选保留角色权威上限，不恢复旧的 200 点上限。载具/物体战斗记录不查询 NPC 生命元数据。
- 新增按原因分类的姿态拒绝计数，以及目标姿态不可用时保守阻挡射击的计数。无效更新保留已接受几何；伤害仍需新鲜有效姿态、归属/生命周期校验、原版命中部件及遮挡确认。

### 兼容与验证

配套启动器 0.2.20，以修复 NPC view 上报被拒绝和未持有武器切换触发重连的问题。既有动作/装备/PED 姿态能力要求及受支持引擎/资源哈希保持不变。常规 JAR 更新保留独立角色/车体几何、地图碰撞和导航，此次无需重新生成几何。

Java 17 编译和 802 项服务端回归通过，覆盖原 NPC 生命预算、阈值边界、玩家生命、载具/物体快照、无效/过期姿态保留、历史/所有权/生命隔离、头盔与爆炸。生命目录生成一致性、输出隔离及原始哈希检查通过；真实 Java WebSocket 联调确认新鲜 NPC 姿态被接受且手枪伤害由服务端结算。这些源码/协议检查不宣称已完成游戏画面或完整原生等价验证。剩余 P0 范围继续列于[下版本计划](../docs/p0-next-release.md#简体中文)。

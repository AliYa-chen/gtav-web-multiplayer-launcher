## English

**Category: Server · Version: 0.4.9-world-experimental**

### Changes

- Fix confirmed vehicle seats rejecting normal native PED offsets as invalid poses. Launcher 0.2.21 supplies the native vehicle centre plus parent entity/generation/owner epoch/seat; the server verifies the attachment and inverse seat map before rebasing all observed bones and optional bounds to the confirmed vehicle centre.
- Bound transport offsets using the existing 250 ms pose lifetime and vehicle speed ceiling only for a currently leased vehicle. An unowned/static vehicle retains the original 5 cm centre tolerance. Require the pelvis inside the original vehicle model's verified collision envelope. Preserve walking origin, bone-distance, skeleton-edge, stale attachment and lifecycle checks; missing vehicle geometry cannot authorize damage. Player and NPC observations use the same attached-body validation.
- Let an authenticated seated player renew its expired character lease through the existing trusted state projection. When the confirmed driver's car has no current lease, offer that car back with a new owner epoch and require readiness before simulation; never take an active lease from another owner. NPC pose acceptance still requires a current lease.
- Report pose refusals as `invalid_ped_pose` instead of always labelling them `invalid_movement`. Actual walking speed/teleport violations retain their movement refusal and correction.

### Compatibility and validation

Pair with launcher 0.2.21 for the attached pose metadata and for correction handling that preserves seated native tasks. Older attached pose messages without the parent identity are rejected. This patch uses the existing ASEA, BLISTA and POLICE geometry; it adds no new model coverage. Routine JAR deployment preserves independently generated world geometry, collision and navigation, with no regeneration required. Full P0 remains incomplete.

Java 17 compilation passes. A real Main/WebSocket integration accepts confirmed seat offsets and a bounded delayed native vehicle centre, accepts a 30 m authoritative drive, rejects an old parent owner epoch with the correct pose code, then accepts leaving and walking. A 5.4-second pause expires both character and vehicle leases; the same session renews the character, receives a new ready offer and resumes driving after acknowledgement. Existing registry/ownership/population and four current-protocol vehicle WebSocket scenarios also pass. Walking origin error and a 60 m teleport remain rejected. Direct Java geometry checks exercise complete bone/bounds translation, original pelvis limits, skeletal integrity, distant origins, NPC seats and invalidation after parent lease changes. Resource/output isolation and unchanged original/world-input hashes pass. This evidence is source/protocol validation and does not record a new rendered gameplay session.

## 简体中文

**分类：服务端 · 版本：0.4.9-world-experimental**

### 更新内容

- 修复已确认入车后正常原生角色座位偏移被当作无效姿态的问题。启动器 0.2.21 提供原生车辆中心及父车辆实体/代数/归属轮次/座位；服务端校验附座与反向座位映射，再将全部观测骨骼和可选包围盒平移到确认车中心。
- 仅当前租约车辆按既有 250 毫秒姿态寿命与车辆速度上限限定网络偏移；无归属/静止车辆保留原 5 厘米中心容差。骨盆须处于原车型验证碰撞包围范围内，步行原点、骨骼距离、骨架边长、过期附座与生命周期校验保持有效；缺少车辆几何不能授权伤害。玩家和 NPC 共用附座身体校验。
- 已认证附座玩家可经既有可信状态投影续期过期角色租约。当前确认司机的车辆无有效租约时，以新归属轮次重新发出该车确认邀请，完成就绪确认后才模拟，不夺取其他所有者的有效租约；NPC 姿态仍须当前有效租约。
- 姿态拒绝准确返回 `invalid_ped_pose`，不再一律误标为 `invalid_movement`；真实步行超速/瞬移仍按移动异常拒绝并纠正。

### 兼容与验证

需配套启动器 0.2.21 的附座姿态身份和保留座内任务的纠正处理。旧客户端未携带父车辆身份的附座消息会被拒绝。此次复用现有 ASEA、BLISTA、POLICE 几何，不增加车型覆盖；常规 JAR 更新保留已有独立角色/车体几何、地图碰撞与导航，无需重新生成。完整 P0 仍未完成。

Java 17 编译通过。真实 Main/WebSocket 联调接受确认座位偏移与限额内迟到原生车中心，接受 30 米权威驾驶，旧父车归属轮次以正确姿态错误码拒绝，随后离车与步行成功；暂停 5.4 秒确认角色和车辆租约均过期，同一会话续期角色、收到新就绪邀请并在确认后继续驾驶，既有登记/归属/人口与四项当前协议车辆 WebSocket 场景亦通过；步行原点偏差和 60 米瞬移仍被拒绝。直接 Java 几何检查覆盖全部骨骼/包围盒平移、真实骨盆范围、骨架约束、远距离原点、NPC 附座和父车租约变化后的姿态失效。资源/输出隔离与原始/世界输入哈希不变检查通过；这些源码/协议证据未记录新的游戏画面测试。

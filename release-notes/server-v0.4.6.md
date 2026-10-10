## English

**Category: Server · Version: 0.4.6-world-experimental**

- Fix physical projectiles disappearing when a static-only collision query finds no obstacle and returns no ticket. Continue authoritative character sweeps; failed, incomplete or timed-out native queries still cannot authorize damage.
- Accept millimetre floating-point error at the declared shot-range boundary without increasing the weapon's effective damage range.
- Attach a newly seated player to the accepted vehicle transform immediately. Passenger entry/exit no longer resets the driver's movement allowance. Detaching resets the character's own allowance and inherited velocity.
- Commit confirmed vehicle destruction atomically: engine health −4,000 or body health 0 releases occupants, stops the engine/motion and revokes simulation ownership. Refuse later seat/ownership acquisition and prevent police ownership reoffers for destroyed vehicles. Non-destroyed damaged vehicles retain their occupants; claimed-vehicle retention is unchanged.
- Keep the existing wire schema and authoritative cooldown/queue validation. Launcher 0.2.18 supplies the matching client shot-delivery and destroyed-state behavior; older clients do not gain those fixes by updating the JAR alone.

Validation covers the actual Java weapon/registry rules, real local WebSocket seat/destruction/shot delivery, and existing world regressions. Player resources and independent world-data inputs remain read-only. Seat-side exit anchors are not complete terrain-safe exits; model-specific vehicle bullet/blast damage, repairs and mounted weapons remain unfinished.

## 简体中文

**分类：服务端 · 版本：0.4.6-world-experimental**

- 修复物理投射物在仅静态碰撞查询“没有障碍、无需票据”时直接消失的问题，继续执行服务端角色扫掠；失败、不完整或超时的原生查询仍不能授权伤害。
- 射程边界容忍毫米级浮点误差，不扩大武器实际伤害射程。
- 上车立即对齐已确认车辆位姿；乘客上下车不再重置司机移动额度，角色下车重置自身额度和继承车速。
- 确认引擎生命 −4,000 或车身生命 0 后，同一事务解除全部乘员、停机/清零运动并撤销模拟权；拒绝再次入座、分配模拟权和警力重复授权。普通受损车辆继续保留乘员，已认领车辆的保留策略不变。
- 保留现有消息结构和服务端冷却/队列校验。配套启动器 0.2.18 提供客户端射击送达和损毁状态修复，仅升级 JAR 不会让旧客户端自动获得这些改动。

验证覆盖真实 Java 武器/注册表规则、本机 WebSocket 座位/损毁/射击送达与已有世界回归。玩家资源及独立世界数据保持只读。座位侧下车锚点不是完整地形安全选点；按车型判定的车辆枪弹/爆炸损伤、维修和车载武器仍未完成。

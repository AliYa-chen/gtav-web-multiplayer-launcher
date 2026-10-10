## English

**Category: Launcher · Version: 0.2.18**

### Changes

- Fix short-step remote locomotion: new movement samples start walking immediately, animation targets stay ahead of the motion, and stopped movement expires without repeated task resets. Heading uses shortest-angle interpolation; respawn, seats and competing actions reset the walk state.
- Preserve observed firing/ammunition pulses through bounded worker and browser queues. Remove duplicate client weapon-cadence filtering and the stale last-impact aiming override; use current aim and the declared weapon range. Reloads and delayed ammunition updates are reconciled without extra shots.
- Follow confirmed vehicle destruction by stopping simulation and refusing new entry. Pair with server 0.4.6 for unobstructed projectile continuation, corrected passenger movement budgets and atomic occupant/ownership release.
- Expand both READMEs with the player/weapon/vehicle priority order and a fixed-version FiveM source comparison. No FiveM code, binary or protocol is imported.

### Compatibility and evidence

The existing engine version gate and 220-export adaptation remain in place; no new native export or game-data write is required. Client queues hold at most eight intents with a one-second lifetime, while the server still owns cadence, geometry and damage. Weapon range does not expand native streamed collision coverage. Full aiming/movement blending, armour/inventory, detailed vehicle damage and special equipment remain separate work.

JavaScript bridge/native-call mock regressions and local WebSocket shot-delivery checks passed, together with resource/output isolation checks. This update does not add a new two-client rendered animation observation. macOS packages retain their development/ad hoc signing status.

## 简体中文

**分类：启动器 · 版本：0.2.18**

### 更新内容

- 修复远端小步移动：新样本立即驱动走路，动画目标保持在运动前方，停步后限时停止，避免反复重启任务。朝向按最短角插值；重生、座位和其他动作切换重置走路状态。
- 原生射击/扣弹脉冲经过两级有界队列保留，取消客户端重复射速过滤及上一发落点覆盖瞄准，使用当前瞄准与声明射程；换弹和延迟扣弹不会重复产生射击。
- 按确认的车辆损毁状态停止模拟、拒绝新入座。配合服务端 0.4.6，修复无遮挡投射物消失、乘客干扰司机移动额度及损毁后的乘员/所有权释放。
- 中英文 README 补充角色、武器、载具的优先顺序及固定版本 FiveM 源码对照；没有引入 FiveM 代码、二进制或协议。

### 兼容与证据

保留现有引擎版本校验和 220 项导出适配，不增加 native 导出，不写游戏数据。客户端队列各最多八项、寿命一秒，射速、几何与伤害仍由服务端裁决。武器射程不扩大原生碰撞流式覆盖；完整移动瞄准混合、护甲/库存、细分车辆损伤和特殊装备仍需单独实现。

JavaScript 桥/原生调用替代回归、本机 WebSocket 射击送达和资源/输出隔离检查通过；本轮没有新增双客户端实际动画观察记录。macOS 包保留开发/ad hoc 签名状态。

# Shared explosive effects: rendering fix in 0.2.16

[English](#english) | [简体中文](#简体中文)

## English

Existing launcher logs record two clients crashing at the same timestamp during grenade-launcher activity. Both rendering threads report `RuntimeError: unreachable` with the same chain:

```text
dlCmdDrawFullScreenGlowQuads::ExecuteStatic
→ CSprite2d::BeginCustomList
→ grmShader::Bind
→ grcEffect::BeginPass
```

The shared projectile adapter called `mpDrawSphere`. Static decoding confirms this is `CommandDrawMarkerSphere → GameGlows::AddFullScreenGameGlow`, rather than an ordinary model marker. Its deferred draw command enters the failing chain. The `BeginPass` trap indicates a missing technique or an invalid pass/program index; the logs do not retain the exact failed condition.

The shared explosion adapter also called `mpVisualExplosion`. Its `noDamage=true` flag suppresses damage but does not remove native explosion objects, physics, sound or event processing. A synchronized visual should not instantiate another native explosion in every client.

The 0.2.16 change uses the ordinary `CommandDrawMarker` native, exposing it as `mpDrawMarker` after validating its symbol and 16-argument ABI. Marker type 28 is `PROP_MK_SPHERE` in this engine's initialization data and uses the separate model-marker path. `mpFrameCount` reads the verified engine frame counter so repeated script callbacks cannot fill the marker pool in one frame.

- Projectiles and persistent areas use ordinary model markers.
- Explosion feedback uses a 450 ms expanding/fading marker. It creates no local explosion or weapon projectile.
- The shared effect renderer attempts at most 32 markers per game frame; explosion events, retained flashes and deduplication records are bounded.
- Old or repeated effects do not restart their lifetime. Effect acknowledgements continue even when drawing is unavailable.
- NPC shot visuals accept only server-declared hitscan/shotgun modes before calling the native bullet interface. Projectile hashes are not replayed as native bullets.
- Server projectile trajectories, collision queries, damage, death and respawn retain their existing authority. Java stays at 0.4.3.

A local Java protocol reproduction with two clients, two RPG shots and one grenade completed collision queries, explosion broadcasts, damage, respawns and heartbeats, and the maintenance clock continued advancing. This did not reproduce a Java stall. The captured client rendering stack provides the concrete basis for this fix; the change does not replace or disable all native local weapon behavior.

The original engine remains read-only. The launcher-generated online runtime SHA-256 is `c4ff9c8fc474d666616d525358a700ed0c73fea4f3742434715a960d5fde95b9`; its size is 63,205,956 bytes. Both native exports are version-checked and the adaptation description is generated from the reference builder.

## 简体中文

现有启动器日志记录了榴弹发射期间两个客户端在同一秒崩溃，渲染线程均报告 `RuntimeError: unreachable`，调用链一致：全屏光晕命令 → 自定义精灵列表 → 着色器绑定 → `BeginPass`。

共享投射物适配器调用的 `mpDrawSphere` 实际是 `CommandDrawMarkerSphere → AddFullScreenGameGlow`，不是普通模型标记。延迟执行的绘制命令正好进入日志中的失败路径。`BeginPass` 的 trap 对应 technique 缺失或 pass/program 索引不合法；日志没有保存足以区分具体条件的现场值。

共享爆炸同时调用了 `mpVisualExplosion`。`noDamage=true` 只抑制伤害，仍会创建原生爆炸并执行物理、声音和事件流程。同步视觉效果不应在每个客户端再次生成原生爆炸。

0.2.16 改用经过名称和 16 参数 ABI 校验的普通 `CommandDrawMarker`，导出为 `mpDrawMarker`。该引擎初始化数据中的 type 28 是 `PROP_MK_SPHERE`，走独立的模型标记渲染路径。`mpFrameCount` 读取经过核对的引擎帧计数，同帧多次脚本回调不会重复填入标记池。

- 投射物及持续区域改用普通模型标记。
- 爆炸提示是 450 毫秒的扩散淡出标记，不生成本地爆炸或武器投射物。
- 每游戏帧最多尝试绘制 32 个标记，效果队列、闪光和去重记录均限制容量。
- 旧效果和重复消息不会重新延长寿命；绘制不可用时仍继续确认事件。
- NPC 弹道表现只允许服务端目录中的 hitscan/shotgun，通过原生子弹接口重放投射物 hash 被禁止。
- 弹道、碰撞查询、伤害、死亡和重生继续由服务端裁决，Java 版本保持 0.4.3。

本地双客户端 Java 协议复现中，两次 RPG 和一次手雷的几何查询、爆炸广播、伤害、重生与心跳正常，维护时间持续推进，没有复现 Java 停顿。本次修复依据实际客户端渲染堆栈，不等于替换或停用全部本地原生武器行为。

原始引擎保持只读。启动器生成的新在线副本 SHA-256 为 `c4ff9c8fc474d666616d525358a700ed0c73fea4f3742434715a960d5fde95b9`，大小 63,205,956 字节。两项原生导出均按版本校验，适配描述由参考构建器生成。

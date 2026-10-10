# Native cloud entry / 原生云层入局

## English

Available in launcher 0.2.17 and server 0.4.5. The implementation uses the player's original title artwork, native `Cloudy 01` resource and script cameras. There is no procedural web-cloud renderer. A three-stage owned-camera descent approximates the single-player character-switch presentation, without calling the original player-switch state machine whose branches change population, dispatch and streaming.

Readiness flows through connection, renderer gate, complete world snapshot, character placement, local collision, owned camera cleanup and negotiated server acknowledgement. The renderer signal alone, elapsed time or a camera returning success never establishes full readiness. Fresh attempt/world/entity generation checks reject stale messages. Ordinary death/respawn after admission uses existing recovery rather than starting a new entry cinematic.

The native cloud manager layout is read-only and tied to original WASM SHA-256 `11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0`. Cloud borrowing requires an empty public script allowlist and no existing override. Cleanup validates manager, container and index, and only runs under the creating handler. Foreign or changed state is preserved. No original game file, raw engine field or global cloud alpha is written.

Once the high-altitude camera is confirmed rendering, each entry draws one random 5–10 second hold before the three descent stages. Readiness gates remain mandatory; losing and regaining readiness does not draw a new delay. Reduced-motion entry still skips the cinematic.

The original LONG ceiling value is 1190 m; the intermediate 300/80 m waypoints and pauses are this project's camera choreography. They are not a claim of invoking the original switch manager. The camera uses the actual gameplay-camera target where valid. Its status distinguishes requested native cloud state from proof of visible pixels; local browser screenshots now confirm visible clouds and the high-altitude view; observed native states confirm all three descent stages and cleanup. Cancellation and reconnect remain separately scoped checks.

The original `Hit_2` cue is requested once at each observed descent segment using the verified original long-switch soundset. Skipped segments are not replayed in a burst; audio errors cannot hold camera cleanup. Normal loading shows only a white/yellow original spinner, a generic loading label and the connected server version as a white Chalet `ONLINE 0.4.5` label above the loading strip. Failure controls appear only after failure.

Server 0.4.5 protects pending users from combat and gameplay writes until `entry_ready`/`entry_status` matches the current identity. Legacy servers have only the client visual/readiness gate. Disconnects clear admission, capped loading time persists across reconnect, and camera/control cleanup is retried only in its owner context.

Local validation covers staged camera ownership, native cloud borrowing/restoration, original-input isolation, state deadlines, stale messages, a matching server ACK, weapon/projectile/near-melee protection and existing-client compatibility. Mock native calls do not prove final visual behavior.

## 简体中文

适用于启动器 0.2.17、服务端 0.4.5。使用玩家原游戏的标题画面、`Cloudy 01` 云层和脚本相机，不绘制替代云背景。受控相机三段下降用于接近三主角切换的观感，不调用会改变人口、调度及流送的原始切换状态机。

就绪顺序为连接、渲染门槛、完整世界快照、角色放置、落点碰撞、本次相机清理、服务端最终确认。单独的渲染信号、时间流逝或创建相机成功均不能代表全部就绪。尝试 ID、world epoch 和角色代次用于拒绝旧消息；已入局玩家的普通死亡/重生沿用原恢复流程，不重播初次镜头。

云管理器只读布局与原始 WASM SHA-256 `11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0` 固定绑定。只有公共脚本空白名单已生效且没有原脚本云覆盖时才临时使用；清理前核对管理器、容器与索引，并回到创建时的 handler。外来或变化后的状态保留。不写原游戏文件、引擎原始字段或全局云透明度。

高空相机确认开始渲染后，每次入局只抽取一次 5–10 秒的随机停留，再开始三段下降；角色与碰撞就绪门槛仍必须满足，就绪丢失再恢复不重新抽取延迟。减少动态效果模式仍跳过镜头。

1190 米高空值来自原 LONG 切换参数；中途约 300/80 米的分段与停顿属于本项目镜头调度，不能描述为直接执行原切换管理器。终点尽量接回真实 gameplay camera。状态只能确认原生云层请求/覆盖，不能代替像素可见性证据，本机内置浏览器截图已确认可见云层和高空画面，原生状态记录三段下降及清理；取消和重连仍按各自验证范围记录。

每个实际下降阶段通过已验证的原 long-switch soundset 各请求一次 `Hit_2` 音效，不集中补播跳过阶段，音频错误不阻止相机清理。正常加载仅显示原素材白/黄圈、“加载中…”，加载条上方用原 Chalet 字体的白色 `ONLINE 0.4.5` 显示实际连接服务端版本，失败后才显示恢复按钮。

服务端 0.4.5 在当前身份的 `entry_ready`/`entry_status` 完成前阻止战斗及游戏写入；旧服务端只有客户端视觉和就绪门控。断线清除入局状态，重连不重置有界加载期限，相机和控制清理只在所属脚本上下文重试。

本地检查覆盖分段相机所有权、原云层取得/恢复、输入隔离、阶段超时、旧消息、匹配确认、枪弹/投射物/近战保护及旧版兼容。模拟 native 不证明最终观感。

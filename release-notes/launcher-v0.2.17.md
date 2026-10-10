## English

**Category: Launcher · Version: 0.2.17**

### Changes

- Add original-engine cloud entry: wait 5–10 seconds in the sky, descend in three stages with native sound cues, then enable play after character, collision and server readiness checks.
- Fix drivers and passengers being pulled back into shared vehicles during exit animations.
- Show the original loading spinner and connected server version; keep the launcher at 1080 × 780 with maximize disabled.
- Add a local development script that stops both components, builds, and restarts them; fix local debug routes and disable debug update checks.
- Preserve read-only game resources. Server-side loading protection requires server 0.4.5; earlier servers retain local readiness checks. macOS packages remain development/ad hoc signed.

### Native cloud entry

- Preserve the original game title artwork until the engine can render. No generated web cloud background is used.
- Use the supported engine's own `Cloudy 01` cloud resource and script camera for a high-altitude entry followed by three descent stages, then restore the gameplay camera. The sequence targets the feel of the single-player protagonist switch; it does not invoke that manager's population-resetting logic or claim pixel-identical original playback.
- Only borrow the native cloud override after public script isolation, when no script override exists. Validate the read-only manager identity and cloud index before restoring current weather; camera destruction stays within its creating script handler.
- Wait for a complete world baseline, valid character/generation, model placement, local collision and finished camera cleanup. With server 0.4.5, wait for the server's matching entry acknowledgement before sending gameplay state or enabling input. Earlier servers retain the local readiness sequence without the new server-side protection.
- Loading uses a compact white/yellow original spinner and a generic loading label, plus the connected server version. Back/Retry controls appear only on failure; Escape cancellation, phase deadlines, reconnect and stale-attempt rejection bound the process. Ordinary death/respawn does not restart the initial cinematic. Reduced-motion entry skips the cinematic after real readiness.

- Confirm camera rendering on a subsequent engine update instead of destroying a valid camera in its creation frame. Refresh/resume no longer silently disables the cinematic, and diagnostic reports preserve skipped/failed camera outcomes.
- Hold the rendered high-altitude view for a random 5–10 seconds per entry before the three descent stages, while retaining all readiness gates and reduced-motion behavior. Restyle the connected server version as a white Chalet `ONLINE` label above the loading strip.
- Trigger the original `Hit_2` protagonist-switch sound once per observed descent stage through the verified native audio path.
- Keep the launcher at a fixed 1080 × 780 content size, with native resize, maximize and fullscreen disabled even under local configuration overrides. Remove duplicate server routes from the announcement card. Debug launchers suppress update metadata and mandatory update gates.

### Shared-vehicle exit

- Fix drivers and passengers being placed back into their seat during native exit animation. The bridge now recognizes that a previously confirmed occupant has left every native seat even while the engine still reports the old vehicle, then requests server release without cancelling the exit or reattaching the player.
- Preserve correction of actual seat shuffles, the other occupants and server ownership rules. Retry delayed leave requests at a bounded rate; unconfirmed seats, changed lifecycles and missing native seat queries cannot be treated as a voluntary exit.
- Validation: 45 world-bridge checks, 79 public-session checks, two registry seat checks and an isolated current-source JVM check of both two-player exit orders passed. No server protocol or original engine change is required.

### Local development runner

- Add `./start-local.sh` for macOS/Linux. After output and dependency preflight, it force-stops the recognized local launcher and Java server before compiling either component, then starts both new builds. A build failure leaves both stopped and reports the build log.
- Use a localhost-only configuration (default `127.0.0.1:18787`), with `--port`, `--status` and `--stop`. Retain build/runtime logs under `archive/local-dev/runs/`; generated server and launcher artifacts stay separate from player resources and release installers.
- Fix local routes being hidden/unavailable in the standalone debug launcher: route selection and HTTP health checks now use the native local-config marker instead of Vite development-server mode. Loopback host/port checks and release HTTPS/WSS restrictions remain enforced.
- Reject unsafe output aliases and special files before building, validate saved process identities against PID reuse, and refuse ports occupied by unrelated applications.

### Documentation

- Add two clickable YouTube video previews to both README translations.

### Resource and validation scope

The local runner passed 19 focused checks, including forced-stop-before-build ordering, no launch after build failure, terminal-hangup survival and unsafe-output rejection. The 33 existing resource/output isolation checks also passed; all 12 original input sizes and SHA-256 values remained unchanged. Local builds, repeated process replacement and the server health endpoint were checked on macOS. The standalone local-route fix passed 33 route/presentation checks plus a production-mode Vite bundle check against the real local health endpoint; local launch-request validation succeeded while release HTTP routes stayed rejected.

Launcher-managed adaptation now describes 220 verified exports. Original game inputs remain read-only; isolated offline bytes match the input exactly. Native camera/cloud ownership, entry-state, bridge and protocol regressions passed. Local in-app-browser observation confirmed visible native clouds, the high-altitude camera, the loading spinner and return to gameplay; runtime transitions recorded all three descent stages. Audio native requests are verified separately from audible output.

## 简体中文

**分类：启动器 · 版本：0.2.17**

### 更新内容

- 新增原游戏云层入局：高空停留 5–10 秒，配合原生音效三段下降，角色、碰撞与服务端就绪后恢复操作。
- 修复司机或乘客在多人共乘下车动画中被拉回座位。
- 显示原版加载圈与当前服务端版本；启动器固定 1080 × 780，禁止最大化。
- 新增先停止两端、再构建并启动的本地开发脚本；修复本机调试线路识别，并关闭开发版更新检测。
- 原始游戏资源继续只读。服务端加载保护需配合 0.4.5，早期服务端保留本地就绪流程；macOS 包仍为开发/ad hoc 签名。

### 原生云层入局

- 引擎可渲染前保留原游戏标题加载素材，不使用网页自绘云背景。
- 使用受支持引擎自带的 `Cloudy 01` 云层与脚本相机，从高空经过三段下降后接回游戏镜头。目标是接近单机三主角切换的观感，不调用会重置人口的原角色切换管理器，也不宣称逐帧等同原流程。
- 仅在公共脚本隔离已生效、没有既有脚本云覆盖时临时使用原生云层。清理前只读核对管理器身份与云索引，恢复当前天气云；相机只由创建它的脚本上下文销毁。
- 等待完整世界基线、有效角色/代次、模型放置、落点碰撞及镜头清理完成。配合服务端 0.4.5，收到匹配的入局确认后才发送游戏状态和启用操作；较早服务端保留本地就绪流程，但没有新增的服务端加载保护。
- 加载时仅显示原素材白色/黄色旋转圈、“加载中…”与当前服务端版本，失败后显示返回/重试；Escape 取消、阶段期限、重连与过期尝试拒绝避免无限等待。正常死亡/重生不重新播放首次入局镜头。减少动态效果模式在真实就绪后跳过镜头。

- 相机在后续引擎帧确认渲染，不再在创建当帧误清理；刷新/恢复身份不再自动跳过镜头，日志保留真实跳过/失败原因。
- 高空相机实际开始渲染后，每次入局随机停留 5–10 秒再三段下降，保留全部就绪门槛和减少动态效果行为；服务端版本改为加载条上方的原 Chalet 字体白色 `ONLINE` 标识。
- 通过已核对的原生音频路径，在每个实际下降阶段各触发一次原版 `Hit_2` 主角切换音效。
- 启动器固定为 1080 × 780 内容尺寸，本地配置覆盖也无法开启调整尺寸、最大化或全屏；移除公告卡片的重复线路信息。开发启动器关闭更新元数据与强制更新门槛。

### 多人共乘下车

- 修复司机或乘客在原生下车动画中被重新塞回座位的问题。即使引擎暂时仍返回原车辆，同步桥也会识别已确认乘员离开所有原生座位的过渡状态，发送服务端离车请求，不再取消下车或强行重新挂接。
- 保留真正错座的纠正、其他乘员及服务端所有权规则；延迟确认时限频重试，未经确认的座位、生命周期变化和缺失原生座位查询不能误判为主动下车。
- 验证：45 项世界同步桥、79 项公共会话、2 项注册表座位检查通过；隔离 JVM 使用当前源码验证双人两种下车顺序。无需修改服务端协议或原始引擎。

### 本地开发启动脚本

- 新增 macOS/Linux 根脚本 `./start-local.sh`：输出与依赖预检后，先强制结束已识别的本地启动器和 Java 服务端，再编译两个组件，最后启动新版；构建失败时两者保持停止，并显示构建日志。
- 使用仅连接本机的配置，默认 `127.0.0.1:18787`，提供 `--port`、`--status` 与 `--stop`。构建和运行日志保存在 `archive/local-dev/runs/`，开发产物与玩家资源、发布安装包分离。
- 修复独立 debug 启动器将本机线路过滤为不可用的问题：线路选择与 HTTP 健康检查改为使用原生本地配置标记，不再依赖 Vite 开发服务器模式；保留回环地址、端口校验和正式线路 HTTPS/WSS 限制。
- 构建前拒绝危险输出别名和特殊文件；停止前核对记录的进程身份防止 PID 复用，端口被其他程序占用时拒绝继续。

### 文档

- 中英文 README 新增两个可点击的 YouTube 视频封面。

### 资源与验证范围

本地脚本通过 19 项定向检查，覆盖先强制停止再构建、构建失败不启动、终端挂断后继续运行及危险输出拒绝；现有 33 项资源/输出隔离回归也全部通过，12 份原始输入的大小与 SHA-256 均保持不变。已在 macOS 实测构建、重复替换进程与服务端健康接口。本机线路修复通过 33 项线路/展示回归，并使用生产模式 Vite 产物请求真实本机健康接口，启动请求校验通过，正式配置仍拒绝 HTTP 线路。

启动器适配现有 220 个已核对导出描述。原始游戏输入只读，隔离离线副本与输入逐字节一致。原生镜头/云层所有权、入局状态、桥接及协议回归已通过；内置浏览器实测已看到原生云层、高空镜头、加载圈和返回游戏画面，运行状态记录完整三段下降。音频 native 请求验证与实际听感分别记录。

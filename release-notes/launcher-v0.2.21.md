## English

**Category: Launcher · Version: 0.2.21**

### Changes

- Fix F-key vehicle entry losing character control after a server position correction. A confirmed seat consumes delayed walking/pose corrections without teleporting its seated character; normal walking corrections remain active.
- Sample attached player/NPC bones only after their exact native seat and skeleton are ready. Use the native vehicle centre as the pose origin and include the vehicle entity, generation, owner epoch and seat identity. Preserve the real bone matrices and seat offset for server validation.
- Use reviewed Traditional Chinese for native game system text, matching the original Chinese font. Connection/lifecycle status, equipment prompts and typed server refusals no longer send Simplified Chinese diagnostics into native HUD text. Unknown Chinese system diagnostics use a Traditional fallback. English selection, launcher/browser language choices, player names and chat content retain their existing behavior; no original font or language files are changed. Remote native panel titles outside the verified character set use `Public session` / `公共戰局`; Unicode HTTPS addresses are normalized to ASCII when the runtime supports it. Browser configuration values remain unchanged.

### Compatibility and validation

Pair with server 0.4.9 for the attached pose identity and normalization. Existing engine hash checks and managed runtime isolation remain in force. The fix preserves the current three-model vehicle geometry scope and does not add all-model seat/damage support or complete the deferred P0 work.

JavaScript bridge regressions exercise the real engine callback, bone sampler, world bridge and pose cleaner with controlled native calls: confirmed-seat corrections preserve vehicle tasks, unfinished/wrong seats suppress poses, attachment identities survive transport, and walking correction still runs. Game-adapter and public-session regressions verify Traditional messages and language switching while retaining the active session. The launcher web build, output-isolation regressions and unchanged original/world-input hashes pass. These checks do not record a new rendered game session.

## 简体中文

**分类：启动器 · 版本：0.2.21**

### 更新内容

- 修复按 F 入车后服务端位置纠正导致角色失去控制的问题。已确认附座时消费迟到的步行/姿态纠正，不直接传送座内角色；正常步行位置纠正继续执行。
- 玩家和 NPC 实际处于确认原生座位、骨骼就绪后才采样附座姿态；以原生车辆中心为锚，携带车辆实体、代数、归属轮次和座位身份，保留真实骨骼矩阵与座位偏移供服务端验证。
- 游戏原生系统文字使用与原中文字体配套的繁体文案。连接/生命周期状态、装备提示和按错误码显示的操作拒绝不再将简体诊断原文交给原生 HUD；未知中文系统诊断使用繁体回退。英语选择、启动器/网页语言选择、昵称和聊天内容保持既有行为，原字体及语言包不修改。远程原生面板标题若超出确认字库范围，显示固定 `公共戰局` / `Public session`；运行环境支持时将 Unicode HTTPS 地址规范为 ASCII，浏览器配置原值不变。

### 兼容与验证

附座身份与归一化需配套服务端 0.4.9。原引擎哈希校验和隔离运行副本生成继续有效；范围仍为现有三种车辆几何，不表示全车型座位/伤害或延期 P0 已完成。

JavaScript 回归以受控原生调用执行真实引擎回调、骨骼采样器、世界桥和姿态清理器，覆盖座内纠正保留车辆任务、未就绪/错误座位不提交姿态、附座身份经过传输保留，以及步行纠正仍执行。游戏适配器与公共会话回归覆盖繁体提示、中英切换和连接保留；启动器网页构建、输出隔离回归及原始/世界输入哈希不变检查通过。这些检查未记录新的游戏画面测试。

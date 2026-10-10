## English

**Category: Server · Version: 0.4.5-world-experimental**

- Negotiate `entry_readiness`; new clients remain pending until an acknowledgement request matches the current world epoch, player entity and generation.
- Pending participants cannot move, shoot, interact, submit simulation results, receive combat damage or hold NPC/vehicle simulation leases. Admission restores their player lease and eligible world participation.
- Duplicate acknowledgements are idempotent. Stale identities fail, repeated hello cannot change the negotiated mode, and the bounded ten-minute loading deadline survives reconnect.
- Existing clients retain legacy admission. New launcher 0.2.17 also supports earlier servers with local visual readiness only; server-side loading protection requires this version.
- Fix deployment preflight mistaking the SSH shell command's embedded script text for a root Nginx worker. Match actual worker process rows exactly while still rejecting root workers and missing workers. Explicitly authorized local rollouts can pause only the automated server deployment through a repository variable; release builds and launcher/configuration delivery continue.
- Automated protocol, real local WebSocket, damage and bridge integration checks passed. Original game resources and independent world data are unchanged.

## 简体中文

**分类：服务端 · 版本：0.4.5-world-experimental**

- 协商 `entry_readiness`；新客户端须用当前世界 epoch、玩家实体和代次确认加载完成后才进入活动状态。
- 等待入局的玩家不能移动、射击、交互、上报模拟、承受战斗伤害或持有 NPC/载具模拟租约；确认后恢复角色租约及共同世界参与资格。
- 重复确认幂等，旧身份拒绝；重复 hello 不能更换已协商模式，十分钟加载期限不会因重连重置。
- 旧客户端保留原入场方式。新启动器 0.2.17 也兼容早期服务端的本地视觉就绪，新增服务端加载保护需要本版。
- 修复部署预检将 SSH shell 命令中携带的脚本文字误判为 root Nginx worker 的问题；现在精确匹配实际 worker 进程行，仍拒绝 root worker 或缺少 worker 的环境。明确获授权的本机部署可通过仓库变量仅暂停自动服务端部署，构建发布和启动器/配置交付照常进行。
- 自动协议、真实本地 WebSocket、伤害和桥接集成检查通过。原游戏资源与独立世界数据不变。

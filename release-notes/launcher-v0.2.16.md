## English

**Category: Launcher · Version: 0.2.16 · Windows x64 and macOS ARM64**

This release contains the browser client, desktop launcher and version-checked engine adaptation. GitHub Actions builds the Windows x64 portable EXE and macOS Apple Silicon App ZIP from the release commit. The macOS build uses ad hoc development signing and is not notarized. Game resources are not included.

### Changes

- Replace synchronized projectile, area and explosion visuals with ordinary model markers, avoiding the fullscreen-glow renderer identified in simultaneous client crash logs.
- Stop replaying native explosions in every client; damage and projectile simulation remain server-authoritative.
- Bound marker attempts to 32 per game frame, keep explosion flashes for 450 ms, and deduplicate repeated events without extending their lifetime.
- Bound effect queues and prevent projectile/explosive hashes from being replayed through the NPC bullet-visual path.
- Add staged English/Chinese development roadmaps with ✅ completed scopes and ❌ unfinished phases.

Server 0.4.3 is compatible and unchanged. The original player engine remains read-only; adaptation is generated in launcher-owned storage. This change fixes the identified shared-rendering path, rather than replacing all native local weapon behavior.

### Checks and release artifacts

Client source checks: 238 passed; desktop UI checks: 97 passed; native adaptation checks: 45 passed; output protection checks: 20 passed. Local verification material is excluded from the repository. One workflow builds, validates and publishes the launcher assets automatically. Deployment of the launcher and changes to index.php remain separate operations.

Download the platform package and the accompanying SHA-256 file from Assets.

[Development/build guide](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher/blob/main/docs/multiplayer-development.md) · [Fix details](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher/blob/main/docs/explosive-rendering.md) · [Website](https://gtav.2t.hk/)

---

## 简体中文

**分类：启动器 · 版本：0.2.16 · Windows x64 与 macOS ARM64**

本版发布网页客户端、桌面启动器及经过版本校验的引擎适配，由 GitHub Actions 按发布提交构建 Windows x64 便携 EXE 和 macOS Apple Silicon App ZIP。macOS 使用 ad hoc 开发签名，未公证。安装包不包含游戏资源。

### 更新内容

- 投射物、持续区域和爆炸提示改用普通模型标记，避开双客户端崩溃日志中已定位的全屏光晕渲染路径。
- 不再在每个客户端重放原生爆炸，伤害与弹道模拟继续由服务端裁决。
- 每游戏帧最多尝试 32 个标记，爆炸提示维持 450 毫秒；重复事件不重启效果寿命。
- 效果队列限制容量，NPC 弹道表现禁止通过原生子弹接口重放投射物/爆炸武器。
- 中英文 README 加入分阶段路线图，用 ✅ 标记明确已完成范围，用 ❌ 标记未完成阶段。

配套服务端保持 0.4.3，不需要更新。玩家原引擎只读，适配副本由启动器在自身目录生成。本次针对已定位的共享渲染路径，不替换全部原生本地武器行为。

### 检查与发布附件

客户端源码检查 238 项、桌面界面 97 项、原生适配 45 项、输出保护 20 项通过。本地检查材料不提交仓库。统一工作流自动构建、核验并发布启动器附件。启动器部署与 index.php 更新独立处理。

从附件下载对应平台的程序及 SHA-256 校验文件。

[开发与构建指南](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher/blob/main/docs/multiplayer-development.zh-CN.md) · [修复说明](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher/blob/main/docs/explosive-rendering.md#简体中文) · [官网](https://gtav.2t.hk/)

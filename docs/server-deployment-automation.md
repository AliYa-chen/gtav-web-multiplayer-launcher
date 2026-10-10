# Automatic server deployment

[Website](https://gtav.2t.hk/) · [Repository](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher)

The single `release.yml` workflow builds and publishes separately versioned launcher and server releases. After a new server release is published, its `deploy-server` job installs the verified JAR into the existing China and US services. Launcher-only updates do not restart servers. The workflow does not change the portal or `remote-config/index.php`.

## Required configuration

Store credentials in GitHub Actions **Secrets**, never in source, release notes, arguments, or logs:

| Secret | Meaning |
| --- | --- |
| `GTA_CN_SSH_HOST`, `GTA_US_SSH_HOST` | Existing China/US SSH hostname or IP. |
| `GTA_CN_SSH_PORT`, `GTA_US_SSH_PORT` | SSH port for each host. |
| `GTA_CN_SSH_USER`, `GTA_US_SSH_USER` | Account permitted to back up/replace JARs and restart existing systemd units. |
| `GTA_CN_SSH_PASSWORD`, `GTA_US_SSH_PASSWORD` | SSH password for each account. |
| `GTA_SSH_KNOWN_HOSTS` | Trusted `known_hosts` lines for both hosts; nonstandard ports use `[host]:port`. Confirm these keys through an already trusted connection. |

Optional Actions **Variables**: `GTA_SERVER_BASE` defaults to `/opt/gta5data-server`; `GTA_CN_PUBLIC_DOMAIN` and `GTA_US_PUBLIC_DOMAIN` default to `gtaserver-cn.2t.hk` and `gtaserver-us.2t.hk`. The existing units are `gta5data-server.service` and `gta5data-world-experimental.service`, listening locally on `17485`/`17486`, with certificate-valid public HTTPS/WSS on `47485`/`47486` and `/<port>/health`, `/<port>/ws`.

The runner requires Python 3.12, Java 17, Node 24, and pinned Paramiko 4.0.0. Existing hosts require Python 3.9+, systemd, Java, and their already configured TLS proxy. Actual JAR changes additionally require root access, `iptables`, `systemd-run`, and Nginx workers running as a non-root account. Deployment creates no new game services, certificates, accounts, or world data.

## Rollout and recovery

1. Verify the release plan against the checkout, all artifact sizes/SHA-256 values and source provenance, and the JAR's actual runtime version. Validate both hosts' secrets and trusted SSH keys before any remote change.
2. Inspect all four existing services. Compare uncompressed JAR entry digests so build timestamps do not cause unnecessary restarts. Identical code at the expected running version receives health/protocol checks only; occupied unchanged services receive HTTPS checks without adding a player. The first automated deployment also recognizes the recorded 0.4.3 JAR digest and exact Java-source digest from commit `4f9e66c97655d8e6904e2a0bde573f614226f651`; both are pinned in the tool, so compiler differences alone cannot restart that known build. Changed code with the same version is refused; bump the server version and its release-notes MD. Downgrades are refused.
3. Update US and China experimental lanes before either main lane. Wait up to 120 seconds per lane for player and connection counts to reach zero. Briefly gate new non-root loopback TCP connections with a tagged firewall rule while preserving existing connections; root-only health checks remain available. Wait for player/connection/socket counts to reach zero again and recheck the gate before activation. If connections remain occupied, fail without interrupting that lane. Remove the rule on every exit; a transient systemd watchdog also removes it after 25 minutes if the runner disappears.
4. Save the old JAR, existing unit/drop-in/environment files, and rendered unit configuration under a private `backups/ci-*` directory on the host. Copy the candidate to private staging, verify its digest, preserve target ownership/mode, and atomically replace it with a fresh file and filesystem sync.
5. Restart the existing unit, verify its local version, then check public HTTPS, WSS welcome, full snapshot, and heartbeat with normal certificate verification. The temporary protocol-check connection leaves and must disappear. Compare installed JAR, configuration hashes, and existing world-data hashes again.
6. If activation or verification fails, gate new connections, allow existing connections to close, atomically restore the old JAR, and recheck the previous version and public protocol. If an existing connection does not close within the deadline, fail safely for operator intervention instead of interrupting it. Stop the rollout; later lanes remain untouched. A failed rollback explicitly requires operator intervention.

The `server-deployment-audit` Actions artifact records source commit, candidate digest, lane outcomes, backup paths, and rollback outcome without credentials or environment contents. Backups remain on the existing hosts. If a release is published but deployment fails, inspect the audit, resolve the cause, and use GitHub's **Re-run failed jobs** to retry the failed deployment with the original build artifacts. Alternatively, run the deployment tool with the original plan and verified `release-server` artifact. Immutable releases are not rebuilt or overwritten merely to retry deployment.

Player resource inputs, extracted world data, certificates, proxy configuration, unit files, and environment files remain unchanged during a regular JAR update.

---

# 服务端自动部署

唯一的 `release.yml` 工作流分别构建并发布独立版本的启动器与服务端。新服务端 Release 发布后，`deploy-server` 将通过核验的 JAR 安装到中国、美国现有服务。仅修改启动器时不会重启服务端；工作流不修改门户或 `remote-config/index.php`。

## 凭据与环境

在 GitHub Actions **Secrets** 中配置两地的 `GTA_CN_SSH_HOST/PORT/USER/PASSWORD`、`GTA_US_SSH_HOST/PORT/USER/PASSWORD`，以及包含两地主机已确认指纹的 `GTA_SSH_KNOWN_HOSTS`。非标准 SSH 端口使用 `[host]:port` 格式。通过已有可信连接确认指纹，禁止自动接受陌生主机密钥。账号须具备备份、替换 JAR 和重启既有服务的权限。凭据不写入源码、更新说明、命令参数或日志。

可选 Actions **Variables**：`GTA_SERVER_BASE` 默认为 `/opt/gta5data-server`，`GTA_CN_PUBLIC_DOMAIN` / `GTA_US_PUBLIC_DOMAIN` 默认为两地现有域名。沿用 `gta5data-server.service` / `gta5data-world-experimental.service`，本机端口 `17485` / `17486`，公网 HTTPS/WSS 端口 `47485` / `47486`，路径为 `/<port>/health` 和 `/<port>/ws`。

运行器使用 Python 3.12、Java 17、Node 24 与固定版本 Paramiko 4.0.0；既有服务器需要 Python 3.9+、systemd、Java 和已配置的 TLS 代理。真正更换 JAR 时还要求 root 权限、`iptables`、`systemd-run` 和以非 root 身份运行的 Nginx 工作进程。自动部署不创建新的游戏服务、证书、账号或世界数据。

## 顺序与恢复

先核对计划、源码提交、产物大小与 SHA-256、真实 JAR 版本和两地 SSH 指纹，再预检全部四条线路。比较解压后的 JAR 条目内容，避免 ZIP 时间戳变化触发重启；运行版本一致且代码相同仅检查服务，有在线玩家时只检查 HTTPS。首轮自动部署另以工具中固定的已部署 0.4.3 JAR 摘要和提交 `4f9e66c97655d8e6904e2a0bde573f614226f651` 对应 Java 源码摘要识别已知版本，避免编译器差异导致重启。代码不同却未升服务端版本时直接拒绝，也不允许降级。

先更新美国、中国实验线路，全部通过后再更新两地正式线路。每条线路等待人数与连接数归零，最多 120 秒；真正激活前用带标记的临时防火墙规则阻止非 root 进程向服务端口新建本机 TCP 连接，保持已有连接和 root 健康检查，再次等待人数、连接和套接字归零并核对入口关闭。仍有连接则失败并保留该线路运行。所有退出路径清理规则；运行器断开时，临时 systemd 看门狗也会在 25 分钟后移除规则。私有 `backups/ci-*` 目录保存旧 JAR、服务单元、覆盖配置、环境文件及渲染后的单元配置，候选文件经暂存哈希校验后以新临时文件原子替换，保留权限和所有者并同步文件系统。

重启后核对本机版本，以及开启正常证书校验的公网 HTTPS、WSS 欢迎消息、完整快照和心跳；核对快照 ID、修订号、流序号、有序分块和本玩家实体，检查连接退出后必须清理。再次核对已安装 JAR、配置和既有世界数据哈希。失败时关闭新连接入口、等待已有连接结束，再原子恢复旧 JAR；等待超时不会中断既有连接，会明确报告需要运维处理。检查旧版健康和公网协议并终止后续线路；回滚失败同样需要运维处理。

Actions 的 `server-deployment-audit` 附件记录来源提交、候选摘要、线路结果、备份路径和回滚结果，不含凭据或环境内容。备份保留在服务器。Release 已发布但部署失败时，检查报告、解决问题，再使用 GitHub 的 **Re-run failed jobs**，用原构建附件重试失败的部署任务；也可使用原计划与原 `release-server` 附件执行部署工具。不能为了重试而重建或覆盖已发布版本。

正常 JAR 更新保持玩家原始资源、提取的世界数据、证书、代理配置、服务单元及环境文件不变。

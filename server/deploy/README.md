# 游戏服务 HTTPS 与双地区部署

中国服务器使用 `gtaserver-cn.2t.hk`，美国服务器使用 `gtaserver-us.2t.hk`。每个地区分别运行正式、实验两个 Java 进程；四个入口是四个独立公共战局，玩家须选择同一个入口才能相遇。地区与线路选项统一由 [远程配置接口](../../remote-config/index.php) 提供；启动器、游戏页面和客户端同步桥读取接口中的 `address`、`health_url`、`websocket_url`，不在客户端代码内写死线路、IP 或备用地址。

Nginx 的 [gtav-stream.conf](gtav-stream.conf) 在原公网游戏端口同时接收 HTTP/WebSocket 和 HTTPS/WSS，根据 TLS 握手分流：明文连接直接到 Java，TLS 连接到 `127.0.0.1:5443` 终止并代理。两地区使用同一端口布局，只向公网开放 TCP 47485、47486；5443、17485、17486 均只监听本机。不额外开放游戏服务的 80/443。

| 地区 / 战局 | 配置接口中的显示地址 | HTTPS 健康检查 | WSS 连接 | 本机 Java |
| --- | --- | --- | --- | --- |
| 中国正式 | `gtaserver-cn.2t.hk:47485` | `https://gtaserver-cn.2t.hk:47485/47485/health` | `wss://gtaserver-cn.2t.hk:47485/47485/ws` | `127.0.0.1:17485` |
| 中国实验 | `gtaserver-cn.2t.hk:47486` | `https://gtaserver-cn.2t.hk:47486/47486/health` | `wss://gtaserver-cn.2t.hk:47486/47486/ws` | `127.0.0.1:17486` |
| 美国正式 | `gtaserver-us.2t.hk:47485` | `https://gtaserver-us.2t.hk:47485/47485/health` | `wss://gtaserver-us.2t.hk:47485/47485/ws` | `127.0.0.1:17485` |
| 美国实验 | `gtaserver-us.2t.hk:47486` | `https://gtaserver-us.2t.hk:47486/47486/health` | `wss://gtaserver-us.2t.hk:47486/47486/ws` | `127.0.0.1:17486` |

每台服务器仅安装其地区的 HTTPS 配置：[中国配置](gtaserver-cn.2t.hk.conf) 或 [美国配置](gtaserver-us.2t.hk.conf)，放入 Nginx 的 `http` 包含目录，例如 `/etc/nginx/conf.d/`。中国迁移时备份并移走旧域名配置，避免同时加载旧配置；中国证书须包含新的 `gtaserver-cn.2t.hk` 名称。域名 DNS 指向各自服务器，客户端访问必须保留游戏端口与路径前缀。

HTTPS 根路径和未配置路径跳转到 `https://gtav.2t.hk/`。明文游戏端口上的 `/health`、`/ws` 继续由 Java 原样处理，Java 根路径也跳转到该网站。健康响应不缓存，CORS 头沿用 Java 的 `Access-Control-Allow-Origin: *`；HTTPS 页面通过接口给出的 HTTPS/WSS URL 连接。

## 独立 Java 服务

新服务器需要 Java 17 或更新版本，建立无登录权限的 `gta5data` 用户及组。在 `/opt/gta5data-server/` 安装正式 JAR，在 `experimental/` 子目录安装实验 JAR；两个进程各自保存内存中的战局。玩家原始游戏包不上传，不由这些服务写入。碰撞与导航仅使用启动器项目导出的独立服务器数据：

```text
/opt/gta5data-server/
  multiplayer-server.jar
  experimental/multiplayer-server.jar
  world-data/collision.bin
  world-data/collision.meta.json
  world-data/roads.bin
  world-data/roads.audit.json
  world-data/ped-navigation.bin
  world-data/ped-navigation.meta.json
```

目录与文件由 root 管理，`gta5data` 只需读取和遍历权限。两份基础 unit [gta5data-server.service](gta5data-server.service) 和 [gta5data-world-experimental.service](gta5data-world-experimental.service) 分别安装至 `/etc/systemd/system/`。它们显式指定同一个只读 `--world-data /opt/gta5data-server/world-data`，防止实验 JAR 因位于子目录而漏载世界数据；它们不共享玩家、身份或世界内存。

```sh
systemd-analyze verify /etc/systemd/system/gta5data-server.service /etc/systemd/system/gta5data-world-experimental.service
systemctl daemon-reload
systemctl enable --now gta5data-server.service gta5data-world-experimental.service
curl --fail http://127.0.0.1:17485/health
curl --fail http://127.0.0.1:17486/health
```

已有中国服务器保留现有基础 unit、用户、JVM 参数和其余设置，按需使用原有两个 `*.override.conf` 调整监听地址；仓库内的 drop-in 保持不变。不要把新基础 unit 无条件覆盖到已有中国服务。已有 drop-in 的默认数据路径为 JAR 同目录的 `world-data`，因此保留原数据布局，或在现场的 drop-in 中明确指定经过校验的独立数据目录。

每次更新先备份现有 JAR、六个世界数据文件、unit 和 Nginx 配置，再在隔离 staging 目录核对 SHA-256。先更新并验证实验战局，再更新正式战局；停服会清空该进程中的身份恢复和世界状态。

## TLS 与续期

Debian/Ubuntu 安装 `nginx` 与支持 `ssl_preread` 的 `libnginx-mod-stream`。将 `gtav-stream.conf` 放入 `http` 目录以外，例如 `/etc/nginx/gtav-stream.conf`，在 `nginx.conf` 顶层添加 `include /etc/nginx/gtav-stream.conf;`，只包含一次；`stream {}` 不能放入 `http {}`。

中国配置沿用 `/etc/ssl/gtaserver/fullchain.pem` 与 `/etc/ssl/gtaserver/privkey.key`，以兼容现有安装位置。证书文件由 root 拥有、权限 `0644`，私钥由 root 拥有、权限 `0600`，证书 SAN 必须覆盖 `gtaserver-cn.2t.hk`。续期时用独立临时文件和原子替换安装新证书、私钥；执行 `nginx -t` 成功后 reload Nginx。证书和私钥不进入 Git。

美国配置与中国配置使用同一套用户提供的证书路径 `/etc/ssl/gtaserver/fullchain.pem` 与 `/etc/ssl/gtaserver/privkey.key`。证书 SAN 必须覆盖 `gtaserver-us.2t.hk`；不要把私钥提交到 Git，也不要将私钥内容输出到日志或复制到项目目录。新证书替换时，先写入独立临时文件并校验证书链、有效期、SAN、密钥匹配与文件权限，再用同一文件系统上的原子替换逐个安装两个目标文件；保留上一套文件用于现场回滚，两个文件都安装成功前不 reload。证书文件由 root 拥有、权限 `0644`，私钥由 root 拥有、权限 `0600`。

证书更新后执行 `nginx -t`，成功后 reload Nginx；无需重启 Java。临时文件校验失败时停止安装；若安装或 Nginx 检查失败，原子恢复已备份的旧证书与私钥，并在检查通过后结束回滚。可以用如下 root 部署钩子完成检查与 reload：

```sh
#!/bin/sh
set -eu
nginx -t
systemctl reload nginx
```

证书由用户选择的受信任签发与续期流程提供。每次续期都按上述临时文件校验、原子替换与 `nginx -t && systemctl reload nginx` 流程安装。

首次开启 stream 前执行 `nginx -t`，确认 Java 已监听内网端口，再 reload Nginx。若已有 Java 占用公网 47485/47486，先验证 Nginx 配置，随后重启 Java 释放公网端口，最后 reload Nginx。回滚时先移除 stream 监听并 reload Nginx，再恢复旧 Java 监听，避免端口冲突。

## 部署检查与线路发布

每个地区都验证两个 HTTPS 健康接口及两个 WSS 入口，包括 `welcome`、公共战局加入、完整世界快照和应用心跳。验证使用默认可信证书，不能使用 `curl -k` 或关闭 TLS 校验。健康响应须显示实际版本、`world_v2` / `session_policy` / `physics_queries` 能力和实际加载数据数量，不能仅检查 HTTP 200：当前 0.4.2 数据为 301,339 个静态三角形、77,824 个道路节点、92,681 个步行导航单元及 228,074 条有向导航连接。

`game_sync: false` 与 `coverage_complete: false` 如实保留：当前数据覆盖局部区域，并采用自有世界同步协议。完成部署与 TLS 验证后，再发布远程配置接口中的该地区正式/实验两条线路。修改接口即可更新启动器和游戏线路；新增端口时同步调整 Nginx 精确路径和接口 URL，不在客户端添加固定线路。

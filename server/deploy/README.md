# 游戏服务 HTTPS 入口

Nginx 同时接收原游戏端口上的 HTTP/WebSocket 和 HTTPS/WSS。`gtav-stream.conf` 根据 TLS 握手将连接分流；原 HTTP/WebSocket 直接转发给 Java，TLS 转发到 `127.0.0.1:5443` 终止并代理。Java 主线路只监听 `127.0.0.1:17485`，实验线路只监听 `127.0.0.1:17486`；客户端原来的公网地址和协议保持可用。

`gtaserver.2t.hk.conf` 增加独立域名，不替换其他站点配置。仅使用已映射的公网游戏端口 47485 和 47486 提供 HTTPS，不新增 80 或 443 监听。域名访问必须保留端口。

| 公网入口 | 本机服务 |
| --- | --- |
| `https://gtaserver.2t.hk:47485/47485/health` | `http://127.0.0.1:17485/health` |
| `https://gtaserver.2t.hk:47486/47486/health` | `http://127.0.0.1:17486/health` |
| `wss://gtaserver.2t.hk:47485/47485/ws` | `ws://127.0.0.1:17485/ws` |
| `wss://gtaserver.2t.hk:47486/47486/ws` | `ws://127.0.0.1:17486/ws` |
| `http://183.66.27.21:47485/health`、`ws://183.66.27.21:47485/ws` | 主线路 Java，协议原样转发 |
| `http://183.66.27.21:47486/health`、`ws://183.66.27.21:47486/ws` | 实验线路 Java，协议原样转发 |

这两个端口的 HTTPS 根路径及其他未配置路径均跳转到 `https://gtav.2t.hk/`。游戏服务自身的 HTTP 根路径也会跳转，直接访问 `http://183.66.27.21:47485/` 或 `:47486/` 同样有效。原游戏端口上的 `/health`、`/ws` 等服务路径继续正常处理。

部署时先备份现有 Nginx 配置和 Java 的 systemd 服务设置，并安装支持 `ssl_preread` 的 stream 模块（Debian/Ubuntu 包为 `libnginx-mod-stream`）。单独安装证书至 `/etc/ssl/gtaserver/fullchain.pem`（`0644`）、私钥至 `/etc/ssl/gtaserver/privkey.key`（`0600`），均由 root 拥有；证书和私钥不进入 Git。

将 `gtaserver.2t.hk.conf` 放入当前 Nginx 的 `http` 包含目录，如 `/etc/nginx/conf.d/`。将 `gtav-stream.conf` 安装至该目录以外，如 `/etc/nginx/gtav-stream.conf`，并在 `/etc/nginx/nginx.conf` 的顶层添加 `include /etc/nginx/gtav-stream.conf;`；不能将 `stream {}` 包含在 `http {}` 内。

将两条 Java 服务的监听参数分别调整为 `--host 127.0.0.1 --port 17485` 和 `--host 127.0.0.1 --port 17486`，其余启动参数保持原值。先执行 `nginx -t` 验证，再重启 Java 服务释放公网端口，最后 reload Nginx。公网需要保留 TCP 47485/47486 映射，5443 和 17485/17486 仅供本机使用。回滚时先移除 stream 监听并 reload Nginx，再恢复原 Java 服务监听参数，以避免端口冲突。

健康响应不缓存，CORS 头沿用 Java 的 `Access-Control-Allow-Origin: *`。页面应将远程配置中的健康接口改为上表 HTTPS 地址；不再从 HTTPS 页面请求 IP 上的 HTTP 接口。新增游戏端口时，在配置中增加对应的精确健康及 WebSocket 路径，并同步更新页面的远程配置。

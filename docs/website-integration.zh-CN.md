# 在其他网站集成多人功能

[English](website-integration.md) | [简体中文](website-integration.zh-CN.md)

本项目提供与特定引擎配套的完整浏览器游戏集成。多人系统由隔离的适配运行副本、JavaScript 同步模块和 Java 权威服务端共同组成，不是一个独立 WASM 文件，也不是通用 JavaScript SDK。实现架构和功能开发流程见[多人开发指南](multiplayer-development.zh-CN.md)。

## 选择集成方式

| 方式 | 需要托管的内容 | 适合场景 |
| --- | --- | --- |
| A. 链接到完整游戏站 | 自己的门户及入口链接 | 推荐现有网站使用 |
| B. 自托管完整游戏站 | 游戏 HTTP 服务、获准提供的资源、运行副本、Java 服务端和 TLS 代理 | 有权向访问者提供所需资源的运营者 |
| C. 自定义游戏页面 | B 的全部内容，再修改本项目页面与同步桥 | 维护兼容引擎集成的开发者 |

GitHub Pages 等静态站点可以托管门户和文档，但不能单独提供 Java WebSocket 服务端、Python 资源接口或 PHP 配置接口。只加载 `game.wasm`，或者向不相关的游戏注入一个多人脚本，都不能实现这里的多人功能。

## A. 在门户添加游戏链接

按 B 的步骤将完整游戏站部署到独立来源，例如 `https://game.example.com`，然后在现有网站添加：

```html
<a href="https://game.example.com/" target="_blank" rel="noopener">
  进入多人游戏
</a>
<a href="https://gtav.2t.hk/">GTAV Web Multiplayer Launcher</a>
<a href="https://github.com/AliYa-chen/gtav-web-multiplayer-launcher">项目源码</a>
```

把 `game.example.com` 换成实际游戏域名。在游戏首页选择在线模式，填写昵称、选择角色与服务器；页面保存加入配置后进入 `/play/`。直接打开没有加入配置的 `/play/` 会显示加入面板，不会自动加入战局。`https://gtav.2t.hk/` 是本项目门户和下载网站，不能假设它提供你的游戏资源。

默认使用独立的顶层页面。跨来源 iframe 还需要适配隔离、浏览器权限和嵌入策略，本项目没有现成的 iframe 集成方案。HTTPS 网站也不能简单读取访问者 `localhost` 启动器中的资源，浏览器的混合内容与本地网络访问限制仍然适用。

## B. 自托管完整游戏站

### 1. 准备源码和只读资源

需要 Python 3.11+、用于编译服务端的 JDK 17+、运行服务端的 Java 17+，以及 Nginx 和受信任的 TLS 证书。浏览器需要近期版本的 Chrome 或 Edge，并支持 WebGPU、WebAssembly 线程、`SharedArrayBuffer` 和 `OffscreenCanvas`；更换成自己的域名不会取消这些要求。

```bash
git clone https://github.com/AliYa-chen/gtav-web-multiplayer-launcher.git /opt/gtav-launcher
cd /opt/gtav-launcher
python3 -B tools/build_multiplayer_client.py --game-dir /srv/gtav-resources --runtime-dir /srv/gtav-runtime
python3 -B tools/build_multiplayer_server.py
```

`/srv/gtav-resources` 必须包含受支持的 `data/manifest.json`、清单登记的数据文件和 `b/8b0b5899ed/` 引擎文件。仓库不包含游戏本体。向访问者提供资源前，应取得所需权利；另一种方式是在门户引导玩家使用桌面启动器及自己准备的本地资源。

服务账号只需读取资源目录，运行副本和日志目录则需要单独的写权限。原始资源始终保持只读，建议使用只读文件系统挂载。构建命令将 `offline/game.wasm`、`online/game.wasm` 和对应 `game.json` 写入 `/srv/gtav-runtime`，不会写入 `/srv/gtav-resources`；离线副本与输入字节完全一致。

当前支持的原 WASM SHA-256 为 `11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0`。适配与启动都会检查版本兼容性和运行副本来源。目录名称相同并不足够；遇到不兼容引擎必须明确失败，不能跳过这些检查。

### 2. 分别启动 HTTP 与战局服务

在仓库根目录，以独立进程启动 Java 服务：

```bash
java -jar server/multiplayer-server.jar --host 127.0.0.1 --port 8787
```

另开一个进程启动游戏 HTTP 服务：

```bash
python3 -B serve_local.py --host 127.0.0.1 --port 8000 --multiplayer \
  --game-dir /srv/gtav-resources --runtime-dir /srv/gtav-runtime \
  --room-server wss://game.example.com/session/ws \
  --log-file /srv/gtav-logs/browser.log
```

两个进程都应由服务管理器维护，现有 systemd 方案见[部署模板](../server/deploy/README.md)。确认 HTTP 服务实际监听 8000：请求端口被占用时，程序可能选择下一个端口。不要把这两个上游端口直接暴露到公网。

`--room-server` 只在 `/api/local-config` 中提供显式开发地址，**不会**替换远程线路目录或设置加入面板的默认线路。配置下文的自有目录前，在加入面板输入完整的 `wss://game.example.com/session/ws`。

### 3. 使用受信任的 HTTPS/WSS 入口

把 `game.example.com` 的 DNS 指向这台主机，将其证书和私钥安装在仓库之外。在 Nginx 的 `http` 配置中加入以下 server 块，替换域名和证书路径：

```nginx
server {
    listen 443 ssl;
    server_name game.example.com;
    ssl_certificate /etc/ssl/game/fullchain.pem;
    ssl_certificate_key /etc/ssl/game/privkey.key;
    ssl_protocols TLSv1.2 TLSv1.3;

    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    location = /session/ws {
        proxy_pass http://127.0.0.1:8787/ws;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
    }
    location = /session/health {
        proxy_pass http://127.0.0.1:8787/health;
        proxy_set_header Connection "";
        proxy_read_timeout 5s;
    }
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

游戏站应位于来源根目录，游戏入口为 `/play/`。页面使用绝对路径，若要整体挂到 `/my-game/`，需要协调修改源码。其他路径全部代理给 Python 服务，包括 `/multiplayer/`、`/i18n.js`、`/b/8b0b5899ed/`、`/engine/`、`/data/`、`/data/batch`、`/api/local-config`、`/api/remote-config` 和 `/api/language`。保留 POST 正文、gzip 批量读取响应、HEAD/Range 请求与 `206 Partial Content`、MIME 类型和上游响应头。

Python 服务发送 `Cross-Origin-Opener-Policy: same-origin`、`Cross-Origin-Embedder-Policy: require-corp` 和 `Cross-Origin-Resource-Policy: same-origin`。代理需保留这些响应头并避免重复；HTTPS 与跨来源隔离共同启用共享内存。脚本、Worker、字体、音频模块和资源尽量保持同源，避免额外处理 CORS/CORP。

限制性 CSP 必须兼容现有内联模块与样式块，并允许实际 Worker、WASM 编译和 HTTPS/WSS 地址；直接照搬门户 CSP 或仅设置 `script-src 'self'` 可能阻止游戏运行。浏览器在 WebSocket 握手中发送页面的 `Origin`。Java 服务接受语法合法的 HTTP(S) 来源，并不实施站点白名单；需要白名单时，应在代理或服务端另行实现。健康响应已有服务端的 CORS 头，不要在 Nginx 中重复添加。生产环境不能用自签证书代替受信任的 TLS。

### 4. 配置自己的服务器目录

当前 Python 服务通过 `serve_local.py::REMOTE_URL` 读取 `https://oss.2t.hk/gtav/`。若要展示自己的可选线路，将 fork 中的 `remote-config/index.php` 部署到 PHP 7.4+ HTTPS 网站，再将 fork 中的这个常量改成自己的接口地址。若还要分发桌面 fork，也需要修改 `desktop/src-tauri/src/remote_config.rs::CONFIG_URL` 并重新构建客户端。目前没有配置接口 URL 的 CLI 选项。

PHP 接口返回 JSON，不是游戏页面。把 `$servers` 数组替换成自己部署的线路，例如：

```php
$servers = [
    ['id' => 'example-main', 'name' => 'Example Session', 'role' => 'Main',
        'address' => 'game.example.com:443',
        'health_url' => 'https://game.example.com/session/health',
        'websocket_url' => 'wss://game.example.com/session/ws',
        'region' => 'Example',
        'i18n' => ['en' => ['name' => 'Example Session', 'role' => 'Main'],
            'zh-CN' => ['name' => '示例战局', 'role' => '主线路']]],
];
```

PHP 其余配置中的网站、状态页和下载地址必须是有效 HTTPS URL，下载哈希需对应实际产物。需要限制公共只读接口的来源时，为预期客户端配置 `ALLOWED_ORIGINS`。分发时保留项目归属声明，自己部署的站点链接不能代替上游版权声明。

游戏读取的是同源 `/api/remote-config` 代理，不直接读取原始 PHP JSON。Python 代理检查配置后返回 `{ "config": { "oltitle": "…", "servers": […] }, "source": "remote", "stale": false }`；失败时返回 `source: "unavailable"` 与 `stale: true`。自定义替代接口必须保留这个包装结构和校验，不能返回 HTML 门户页或猜测服务器端口。显式 `websocket_url` 可保留 `/session/ws`；只输入 `game.example.com` 则默认使用 `/ws`。

## C. 集成自定义游戏页面

从 `client/index.html` 开始修改，不要复制一段不完整代码。页面模块与引擎生命周期相互配合：

1. 初始化语言和加入面板，获得正规化的加入配置，调用 `startPublicSession(preferences, onStatus, options)` 并等待 `ready` Promise。
2. 通过 `/b/8b0b5899ed/loader.js` 创建引擎 Worker，在 Worker 启动前调用 `installGameAdapter(worker, publicSession, { watchOnlineConfiguration })`。
3. 每条 Worker 消息交给 `adapter.onWorkerMessage(message)`，同时保留输入、音频、HUD 和就绪状态处理。转交画布，并使用现有页面提供的相同初始化字段。
4. 保留现有世界就绪通知，只在该门控确认后调用 `adapter.setEngineReady()`。保留 loader 的离线/在线运行副本选择、GPU/I/O Worker、共享内存桥、重连及清理逻辑。新功能应保持服务端权威，不能仅修改本地显示状态。

以上函数是内部集成点，不代表独立稳定 SDK 的承诺。其他游戏引擎没有本项目的 native 绑定、内存布局或脚本上下文回调；支持它们需要新的引擎适配器和兼容的协议实现。

每个 Java 进程提供一个 `PUBLIC` 战局，人数可配置为 1–8 人，默认 8 人。两个网站连接相同 WSS 地址时，进入的就是同一战局；独立战局需要独立服务端进程和地址。目前没有按网站、租户或 `room_id` 自动分房的 API。网站登录账号也不会自动成为游戏身份；整合账号需要自己实现后端与协议适配。

## 升级与归属声明

页面、loader、多人模块、运行副本构建器和 Java 服务端应一起维护。适配逻辑或 native 绑定变化后，为每一份选定的受支持资源重新生成运行副本，输出仍在资源目录之外；Java 改动后重新构建并部署 JAR；嵌入源码或 Rust 改动后重新构建桌面客户端。功能分工和构建细节见[多人开发指南](multiplayer-development.zh-CN.md)。

在副本或软件的重要组成部分中保留 [MIT 许可](../LICENSE) 的版权声明与许可声明。版权声明包含[项目官网](https://gtav.2t.hk/)和[仓库](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher)，这些地址需随声明保留。分发时附带[第三方声明](../NOTICE.zh-CN.md)。MIT 授权覆盖项目原创代码和文档，不覆盖游戏素材、原始引擎或商标。

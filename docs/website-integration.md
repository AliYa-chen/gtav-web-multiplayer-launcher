# Integrating multiplayer into another website

[English](website-integration.md) | [简体中文](website-integration.zh-CN.md)

This project provides a complete, engine-specific browser game integration. Its multiplayer system combines an adapted runtime copy, JavaScript synchronization modules, and a Java authoritative server. It is not a standalone WASM file or a general-purpose JavaScript SDK. See [multiplayer development](multiplayer-development.md) for the architecture and feature workflow.

## Choose an integration model

| Model | What you host | Suitable use |
| --- | --- | --- |
| A. Link to a complete game site | Your portal and a link | Recommended for an existing website |
| B. Host the complete game site | Game HTTP host, permitted resources, runtime copies, Java server and TLS proxy | Operators who have rights to serve the required resources |
| C. Customize the game page | Model B plus changes to this project's page and bridge | Developers maintaining a compatible engine integration |

A static site, including GitHub Pages, can host the portal and documentation. It cannot provide the Java WebSocket server, Python resource API, or PHP configuration endpoint by itself. Loading only `game.wasm`, or injecting one multiplayer script into an unrelated game, does not provide multiplayer.

## A. Add a game link to your portal

Deploy the complete game host from model B at a dedicated origin such as `https://game.example.com`. Add this link to your existing site:

```html
<a href="https://game.example.com/" target="_blank" rel="noopener">
  Play multiplayer
</a>
<a href="https://gtav.2t.hk/">GTAV Web Multiplayer Launcher</a>
<a href="https://github.com/AliYa-chen/gtav-web-multiplayer-launcher">Source code</a>
```

Replace `game.example.com` with your actual game host. On the game homepage, choose online mode and provide a nickname, character and server; the page saves the entry preferences and navigates to `/play/`. A cold `/play/` entry without preferences opens the join panel; it does not automatically join a session. The project portal `https://gtav.2t.hk/` is a project/download website, not an assumed game-resource host.

Use a separate top-level page by default. Cross-origin iframes need additional isolation, browser permissions and embedding policy work; this project does not offer a ready-made iframe integration. An HTTPS website cannot simply load resources from a visitor's `localhost` launcher: mixed-content and local-network browser restrictions apply.

## B. Self-host the complete game site

### 1. Prepare source and read-only resources

Use Python 3.11+, JDK 17+ for the server build, Java 17+ to run it, and Nginx with a trusted TLS certificate. Recent Chrome or Edge must support WebGPU, WebAssembly threads, `SharedArrayBuffer` and `OffscreenCanvas`; these requirements still apply when the host uses your domain.

```bash
git clone https://github.com/AliYa-chen/gtav-web-multiplayer-launcher.git /opt/gtav-launcher
cd /opt/gtav-launcher
python3 -B tools/build_multiplayer_client.py --game-dir /srv/gtav-resources --runtime-dir /srv/gtav-runtime
python3 -B tools/build_multiplayer_server.py
```

`/srv/gtav-resources` must contain the supported `data/manifest.json`, data files, and `b/8b0b5899ed/` engine files. The game is not included in this repository. Obtain all necessary rights before serving resources to visitors. The alternative is a portal that directs players to the desktop launcher and their own local resources.

Give the service account read access to the resource directory and write access to the separate runtime/log directories. Keep resources read-only, preferably with a read-only filesystem mount. The build creates `offline/game.wasm`, `online/game.wasm` and their `game.json` records in `/srv/gtav-runtime`; it never writes into `/srv/gtav-resources`. The offline copy equals the input bytes.

The supported original WASM SHA-256 is `11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0`. Both adaptation and startup check compatibility and runtime provenance. A matching directory name is insufficient; an unsupported engine must fail rather than bypass these checks.

### 2. Run HTTP and game services separately

From the repository root, run the Java service in one process:

```bash
java -jar server/multiplayer-server.jar --host 127.0.0.1 --port 8787
```

Run the game HTTP host in another process:

```bash
python3 -B serve_local.py --host 127.0.0.1 --port 8000 --multiplayer \
  --game-dir /srv/gtav-resources --runtime-dir /srv/gtav-runtime \
  --room-server wss://game.example.com/session/ws \
  --log-file /srv/gtav-logs/browser.log
```

Use service supervision for both processes; [deployment templates](../server/deploy/README.md) describe the existing systemd setup. Confirm that the HTTP service actually binds port 8000: it can select the next port when the requested one is occupied. Keep both upstream ports private.

`--room-server` exposes an explicit development address in `/api/local-config`. It does **not** replace the remote catalog or set the join panel's default selection. Until you configure your own catalog below, enter the full `wss://game.example.com/session/ws` address in the join panel.

### 3. Put trusted HTTPS/WSS in front

Point DNS for `game.example.com` to this host. Install its certificate and key outside the repository, then put this server block inside Nginx's `http` configuration. Replace the domain and certificate paths:

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

Keep the game host at the origin root, with `/play/` as the game entry. The page uses absolute paths, so mounting everything under `/my-game/` needs coordinated source changes. Proxy all other paths to the Python host, including `/multiplayer/`, `/i18n.js`, `/b/8b0b5899ed/`, `/engine/`, `/data/`, `/data/batch`, `/api/local-config`, `/api/remote-config` and `/api/language`. Preserve POST bodies, gzip batch responses, HEAD/Range requests and `206 Partial Content`, MIME types and upstream response headers.

The Python host sends `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin`. Preserve these headers without duplicates; HTTPS and cross-origin isolation enable shared memory. Keep scripts, workers, fonts, audio modules and resources on this same origin to avoid separate CORS/CORP work.

A restrictive CSP must allow the existing inline module/style blocks, actual workers, WASM compilation and HTTPS/WSS endpoints; copying a portal CSP or using only `script-src 'self'` can break the game. Browsers send the page's `Origin` on WebSocket handshakes. The Java service accepts syntactically valid HTTP(S) origins, not a site allowlist; an operator requiring a site allowlist must enforce it at the proxy or server. Health responses already carry the server's CORS header; do not duplicate it in Nginx. A self-signed production certificate is not a substitute for trusted TLS.

### 4. Configure your own server catalog

The checked-in Python host reads `serve_local.py::REMOTE_URL`, currently `https://oss.2t.hk/gtav/`. To provide your own selectable routes, deploy your fork of `remote-config/index.php` on a PHP 7.4+ HTTPS host, then set this constant in your fork to that endpoint. For a desktop fork, also update `desktop/src-tauri/src/remote_config.rs::CONFIG_URL` and rebuild the desktop client. There is no catalog-URL CLI option today.

The PHP endpoint returns JSON; it is not the game page. Replace its `$servers` array with your deployment's routes, for example:

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

Keep valid HTTPS website/status/download URLs and actual artifact hashes in the remaining PHP configuration. Configure `ALLOWED_ORIGINS` for your intended consumers when restricting its public read API. Preserve project attribution in your distribution; your own deployment's links do not replace the upstream copyright notice.

The game reads the same-origin `/api/remote-config` proxy, not raw PHP JSON directly. The Python proxy validates raw configuration and returns `{ "config": { "oltitle": "…", "servers": […] }, "source": "remote", "stale": false }`; failures return `source: "unavailable"` and `stale: true`. A custom replacement must preserve this envelope and validation, not serve an HTML landing page or guess a server port. Explicit `websocket_url` preserves `/session/ws`; a bare `game.example.com` defaults to `/ws` instead.

## C. Integrate a custom game page

Start from `client/index.html` rather than copying a partial snippet. Its modules and engine lifecycle are coupled:

1. Initialize language and the join panel, obtain normalized preferences, call `startPublicSession(preferences, onStatus, options)` and await its `ready` promise.
2. Create the engine worker from `/b/8b0b5899ed/loader.js`. Call `installGameAdapter(worker, publicSession, { watchOnlineConfiguration })` before worker startup.
3. Forward each worker message to `adapter.onWorkerMessage(message)` while retaining input, audio, HUD and readiness handling. Transfer the canvas and pass the same initialization fields that the existing page supplies.
4. Preserve the existing world-ready notification and call `adapter.setEngineReady()` only at that gate. Keep the loader's offline/online runtime selection, GPU/I/O workers, shared-memory bridge, reconnect handling and cleanup intact. New features must retain server authority rather than changing local visual state alone.

The functions above are internal integration points, not a promise of a stable independent SDK. Arbitrary game engines do not implement this project's native bindings, memory layout or script-context callbacks. Supporting one requires a new engine adapter and compatible protocol implementation.

Each Java process hosts one `PUBLIC` session, with a configurable capacity of 1–8 players (default 8). Two websites connecting to the same WSS endpoint share that session. Separate sessions need separate server processes/endpoints; there is no built-in website, tenant or `room_id` routing API. Your website's login is also not automatically a game identity: integrating accounts requires your own backend and protocol work.

## Upgrades and attribution

Track the page, loader, multiplayer modules, runtime builder and Java server together. After changes to adaptation/native bindings, regenerate each selected supported resource set's runtime outside its resource directory. After Java changes, rebuild and deploy the JAR. Rebuild desktop clients when embedded sources or Rust code change. See [multiplayer development](multiplayer-development.md) for feature ownership and build details.

Preserve the [MIT License](../LICENSE) copyright and permission notice in copies or substantial portions. The copyright notice includes [the project website](https://gtav.2t.hk/) and [repository](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher); preserve those addresses. Carry the [third-party notice](../NOTICE.md) with distributions. The MIT grant covers original project code and documentation, not game assets, the original engine or trademarks.

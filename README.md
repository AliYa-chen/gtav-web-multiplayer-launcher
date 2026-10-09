# GTAV Web Multiplayer Launcher

[English](README.md) | [简体中文](README.zh-CN.md)

A desktop launcher, browser client bridge, and experimental Java shared-world server for a supported GTAV browser engine. The launcher reads the player's own resources and runs the game in a WebGPU browser.

**[Website](https://gtav.2t.hk/) · [GitHub repository](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher)**

The repository contains project source and documentation. **It does not provide the game, the original browser engine, RPF archives, maps, textures, fonts, or other proprietary game assets.** A regular PC GTA V installation is not a replacement for the supported browser-engine resource layout.

## Current scope

- Tauri 2 launcher for Windows x64 and macOS Apple Silicon; game rendering runs in the default browser.
- Story, sandbox, and public-session launch modes; English, Simplified Chinese, and system language selection.
- Read-only resource discovery and version checks, isolated engine/font caches, and local or LAN HTTPS resource serving.
- Public-session endpoints, names, announcements, and download metadata come from the [configuration API](https://oss.2t.hk/gtav/). Public server addresses are not compiled into the client.
- A standalone Java 17+ server owns player/entity identity, seats, ownership leases, combat decisions, respawning, population, weather, and law rules. Authorized client engines execute assigned native movement and vehicle simulation.

**Client 0.2.15 and server 0.4.3-world-experimental.** This revision includes passenger-seat reconciliation and ownership fixes. The macOS build was verified locally, the Windows build was produced by GitHub Actions and verified, and server 0.4.3 is deployed to the main and experimental sessions in both China and the US (four routes). Uploading the client packages and configuration to the download website remains a manual step. See the [0.2.15 build and deployment record](docs/0.2.15多人同乘与公开源码.md); source and build versions alone do not establish the version currently offered by the download site.

Multiplayer remains experimental. Static collision and pedestrian navigation cover roughly **600 × 600 metres around the test spawn**, not the whole map. There is no complete server-side RAGE physics runtime or migration of every single-player script, tool, mission, or vehicle weapon. This uses a custom protocol and does not implement native GTA Online or FiveM compatibility. Protocol tests do not establish complete gameplay synchronization; `game_sync` and `native_clone_transport` remain false.

## Gameplay screenshots

These screenshots record earlier gameplay demonstrations. Game content remains subject to its owners' terms; see [NOTICE.md](NOTICE.md).

![Two browser clients showing a vehicle and nearby players outside Los Santos Customs](docs/images/multiplayer-vehicles.jpg)

*Vehicle and nearby players rendered in two browser clients.*

![A nighttime gameplay scene with a police vehicle and its flashing lights](docs/images/police-response.jpg)

*Police presence and wanted-level indicators during the earlier demonstration.*

<details>
<summary>More gameplay screenshots</summary>

![Two browser clients showing players aiming toward one another](docs/images/player-combat.jpg)

*Player combat viewed from two clients.*

![The in-game map with separate markers for two players](docs/images/map-player-markers.jpg)

*Player markers on the in-game map.*

![Two client views of a firefight with visible hit feedback](docs/images/combat-hit.jpg)

*Hit feedback during a player firefight.*

![One client showing a fallen player and the other showing the death screen](docs/images/combat-death.jpg)

*The same combat scene and a player's death screen.*

</details>

## Quick start

### Desktop application

1. Visit the [website](https://gtav.2t.hk/) for the available client build and current server status.
2. Open the Windows EXE or macOS App and select your own supported browser-game resource folder.
3. Choose story, sandbox, or a public session. For public sessions, choose an available line and provide a nickname and character preset.
4. Start the game in a recent Chrome or Edge with WebGPU, WebAssembly threads, and shared-memory support.

The packaged launcher does not require Python, Java, Node.js, or Rust. Windows needs WebView2. Current macOS builds use development/ad hoc signing and are not notarized. See the [desktop guide](desktop/README.md) for resource discovery, LAN sharing, certificate trust, and platform requirements.

### Run from source

Install Python 3.11+. Prepare a supported resource root outside the repository, containing:

```text
/path/to/browser-game/
├── b/8b0b5899ed/game.wasm
├── b/8b0b5899ed/game.js
├── b/8b0b5899ed/io_worker.js
├── b/8b0b5899ed/wgpu_worker.js
└── data/manifest.json          # and the matching game data
```

From the repository root:

```sh
python3 -B tools/build_multiplayer_client.py --game-dir "/path/to/browser-game"
python3 -B serve_local.py --game-dir "/path/to/browser-game" --host 127.0.0.1 --open
```

The first command creates launcher-managed offline and online runtime copies in `client/runtime/`. It checks the original engine SHA-256 and rejects incompatible versions. It does not modify the resource directory. The offline copy matches the original bytes. See [resource isolation](docs/启动器资源隔离.md) for the supported hash and external runtime paths.

Keep the terminal open while playing. Use `Ctrl+C` to stop. Do not open the HTML through `file://`; the local server supplies the required isolation headers and range requests. On Windows, use an installed Python 3.11+ (`python` or `py -3`) or see the optional launch scripts; a Python runtime is not included in a source checkout.

### Build and run a local shared-world server

Install a JDK 17+ and Python 3.11+. The server has no Maven, database, third-party Java library, or game-engine runtime dependency:

```sh
python3 -B tools/build_multiplayer_server.py
java -jar server/multiplayer-server.jar --host 127.0.0.1 --port 8787
```

Check `http://127.0.0.1:8787/health`. A separately installed `server/world-data/` can provide local collision/navigation data; the source repository does not ship game-derived geometry. The health endpoint reports the data actually loaded. See the [server guide](server/README.md) and [deployment guide](server/deploy/README.md) for remote hosting, TLS, service management, and rollback.

After preparing the client runtime, a local two-client development session can start the server automatically:

```sh
python3 -B serve_local.py --game-dir "/path/to/browser-game" --host 127.0.0.1 \
  --start-room-server --room-server 127.0.0.1:8787 --instances 2 --open
```

Stop a separately running server before using `--start-room-server`. Development endpoints are explicit arguments; normal players use the API-provided public lines.

## Build the desktop client

Install Node.js 22.12+ (CI uses Node 24), stable Rust, and the platform's [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/): Xcode Command Line Tools on macOS or MSVC build tools and WebView2 on Windows.

```sh
cd desktop
npm ci
npm run desktop:dev
```

Build on the target operating system:

```sh
# macOS Apple Silicon App
npm run desktop:build:mac

# Windows x64 portable EXE, from a Windows terminal
npm run tauri -- build --no-bundle
```

Outputs are under `desktop/src-tauri/target/release/`; the macOS App is in `bundle/macos/`. Desktop artifact names retain the existing `GTA5Data` prefix. The two manual GitHub Actions workflows produce build artifacts and do not publish GitHub Releases. Game resources are not required or embedded for a desktop source build.

## Repository layout

| Path | Purpose |
| --- | --- |
| `client/` | Browser entry page, loading workers, language strings, and project-owned runtime integration. |
| `client/index.html` | Browser mode selection and game-loading UI served by the launcher. |
| `client/loader.js` | Loads the selected isolated runtime and connects the engine workers. |
| `client/multiplayer/` | Public-session transport, player/world snapshots, native entity bridge, and action/effect replication. |
| `desktop/` | Tauri desktop application and its npm/Cargo manifests and lockfiles. |
| `desktop/src/` | Launcher UI, locale dictionaries, server health checks, and settings interactions. |
| `desktop/src-tauri/` | Rust resource discovery, engine validation/cache preparation, local/LAN serving, and native desktop commands. |
| `desktop/scripts/` | Platform build helpers, including the local macOS App build. |
| `server/src/main/java/` | Standalone Java shared-world server, protocol, entity registry, combat, AI, ownership, and map-query logic. |
| `server/deploy/` | Remote deployment instructions, service configuration, TLS/proxy setup, and maintenance scripts. |
| `remote-config/index.php` | Deployable JSON configuration endpoint for announcements, server lines, client versions, download URLs, and hashes. The status website is maintained separately. |
| `tools/` | Build/package tools, read-only engine analysis, isolated adapter generation, and optional world-data extraction. |
| `tools/readonly_game_outputs.py` | Shared output guard and atomic publishing helpers that protect player resource inputs. |
| `docs/` | Design notes, protocol documentation, audits, limitations, and historical release/deployment evidence. |
| `.github/workflows/` | Manually triggered macOS and Windows client builds. |
| `serve_local.py` | Optional Python local HTTP/resource server and explicit local multiplayer development startup. |
| `Launch-Local.cmd` / `Start-Local.ps1` | Windows wrappers for starting the Python local server; require an available Python runtime. |
| `AGENTS.md` | Mandatory development rules, including the read-only game-resource boundary. |
| `.gitignore` | Excludes game resources, runtime caches, binaries, local verification files, and other generated/local material. |
| `README.md` / `README.zh-CN.md` | English project entry guide and its Simplified Chinese version. |
| `LICENSE` / `NOTICE.md` / `NOTICE.zh-CN.md` | MIT License, copyright/project links, and bilingual third-party/game-resource scope notices. |

Player resources such as `gta5data/`, generated `client/runtime/`, extracted `server/world-data/`, and desktop build/download outputs are local material, not source-distribution contents. Local verification files are also excluded from commits.

## Resource and distribution rules

Player resources are **read-only**, including external resource folders, manifests, original WASM/JS, archives, maps, and fonts. Implement features in launcher code, the client bridge, isolated launcher caches, or the server. Never write an adapted engine back to the source folder, bypass version checks, or depend on a previous local game-resource modification. Generated server geometry belongs in separate `server/world-data/` and must not be committed. Output protection rejects game-directory destinations, symlink escapes, and input-file aliases; publication uses independent temporary files and atomic replacement.

The launcher intentionally includes a distributable **LAN CA private key** for its existing local sharing design. It is extractable and is not a confidential production identity. Production TLS certificate/private-key files and server login credentials are not part of this repository. See the [desktop LAN HTTPS guide](desktop/README.md#局域网-https-资源共享) for the trust model.

Before contributing, follow [AGENTS.md](AGENTS.md). Check source-only staging with `python3 -B tools/check_git_contents.py`. Published technical reports describe the implemented scope and recorded static and protocol checks.

## Documentation

The detailed technical reports are currently in Chinese. Older version sections describe their recorded state, not current completion.

- [Launcher and resource isolation](docs/启动器资源隔离.md) · [Desktop usage/builds](desktop/README.md)
- [Remote configuration](docs/远程启动器配置.md) · [Localization](docs/启动器国际化.md)
- [World-server design](docs/统一世界服务端设计.md) · [Shared environment](docs/统一世界环境协议.md)
- [Weapon catalog and authoritative combat](docs/武器目录与权威战斗.md) · [AI and script migration](docs/AI行为与事件迁移.md)
- [Population and pedestrian AI](docs/服务端人口与步行AI.md) · [Collision and physics](docs/服务端碰撞与物理实现.md)
- [Native-network feasibility](docs/原生网络复制可行性审计.md) · [Browser/FiveM boundaries](docs/FiveM参考与浏览器实现边界.md)
- [Loading flow](docs/加载流程与启动器入口.md) · [0.2.15 release record](docs/0.2.15多人同乘与公开源码.md) · [0.2.14 release record](docs/0.2.14中美线路与构建记录.md)

## License

Project-owned original code and documentation use the standard **[MIT License](LICENSE)**. You may use, modify, merge, publish, distribute, sublicense, and sell copies, including commercially. Keep the copyright notice and permission notice in all copies or substantial portions. The copyright notice includes the [website](https://gtav.2t.hk/) and [repository](https://github.com/AliYa-chen/gtav-web-multiplayer-launcher). MIT does not impose an additional UI-attribution or source-disclosure requirement.

The software is provided **AS IS, without warranty**. The complete disclaimer and limitation of liability are in LICENSE. [NOTICE.md](NOTICE.md) and [NOTICE.zh-CN.md](NOTICE.zh-CN.md) explain the copyright and third-party scope.

This license grants no rights to GTA/GTAV game content, the original engine, game-derived assets, trademarks, or third-party materials. Their respective owners' terms remain applicable. This is an independent project and does not claim affiliation with or endorsement by Rockstar Games, Take-Two Interactive, or the original engine's authors.

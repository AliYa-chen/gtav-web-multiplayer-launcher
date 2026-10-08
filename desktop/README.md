# GTA5Data 桌面启动器

Tauri 2 原生界面，Rust 后端直接校验资源、生成运行副本并提供本地 HTTP 服务。用户无需安装 Python、Java、Node.js 或 Rust；这些只用于开发和构建。游戏在默认浏览器中运行，建议使用支持 WebGPU 的新版 Chrome 或 Edge。

## 使用

1. Windows 双击 `gta5data-launcher.exe`；macOS 打开 `GTA5Data Launcher.app`。
2. 点击“选择文件夹”，选择自己的游戏资源包。
3. 点击“启动游戏”。首次启动自动完成目录识别、版本校验、运行引擎与字体缓存准备，然后打开浏览器。
4. 在游戏主页选择单人模式，或按 O 加入远程公共战局。测试多人时可在启动器点击“另开一个客户端”。

启动器记住最近成功校验的目录和首个本地端口。关闭启动器会关闭所有由它开启的本地 HTTP 服务；再次启动无需手动运行任何脚本。

可选择以下任意一级目录：

```text
玩家自己的任意文件夹名/           ← 可以选择这里
└── mirror/                    ← 也可以选择这里
    └── 任意站点文件夹名/        ← 实际资源根：同级含 b 和 data
        ├── b/                ← 可以单独选择 b 或里面的构建目录
        │   └── 8b0b5899ed/
        │       ├── game.wasm
        │       ├── game.js
        │       ├── io_worker.js
        │       └── wgpu_worker.js
        ├── data/             ← 可以单独选择 data
        │   ├── manifest.json
        │   ├── common/...
        │   └── x64/...
        └── index.html        ← 有无此文件均不影响；不会使用它
```

也支持直接在资源根下放 `b/` 和 `data/`，无需 `mirror`。目录扫描有深度和数量限制，选择到多个资源包时要求改选其中一个，不会任意猜测。识别依据是资源结构和清单，版本依据是完整原引擎 SHA-256；同时读取一个小数据文件的 MD5 作为诊断信息。单独 MD5、目录名或 index.html 均不能代替版本校验。目前支持原引擎 SHA：`11ca8d2c04c5e843d18ff4aea4899d72c86973c6b031df334e67c446b2ae83e0`。

## 单文件与资源边界

Windows 可分发单个 EXE，不附 Python 或外部网页文件。macOS 的 `.app` 是系统标准应用包，用户看到一个应用图标，可用一个 ZIP 或 DMG 分发。构建目标分别依赖对应操作系统；macOS 本机产物不能冒充 Windows EXE。

Tauri 窗口使用操作系统 WebView。Windows 需要系统具备 Microsoft Edge WebView2 Runtime（Windows 11 通常自带）；单个便携 EXE 不包含整个浏览器运行库。游戏网页在默认浏览器运行，以使用浏览器的 WebGPU 和 WASM 线程。

应用只嵌入自有 `client` 网页文本源码、启动器界面和小型引擎适配描述。原游戏目录始终只读：

- 原 `game.wasm` 仅供本机构建输入；离线与在线运行副本写入系统应用缓存。
- 原字体从玩家自己的原引擎和 RPF 资源读取，解压后写入应用缓存；不修改清单或增加字体别名到游戏目录。
- HTTP 始终使用内嵌 `client/index.html`，不回退资源包中的首页。
- 游戏目录的 WASM HTTP 入口停用；只开放启动器缓存里的 `/engine/offline/game.wasm` 和 `/engine/online/game.wasm`。
- 本地服务仅监听 `127.0.0.1`，提供跨域隔离、范围读取和批量资源读取；不会启动本地 WebSocket 或 Java 房间服务。
- 设置、生成物和日志使用操作系统应用目录，不要求启动器所在位置可写。源码仓库及分发应用均不包含游戏数据、字体或密钥。

缓存不是另一份完整的 20GB 游戏，仅含两份运行引擎和五个字体库。更新适配器后缓存会按实际内容重新校验。

## 开发和构建

安装当前稳定 Rust、Node.js 22.12+，以及平台的 Tauri 构建前提（Windows MSVC 构建工具、macOS Xcode Command Line Tools）。在项目根运行：

```sh
cd desktop
npm ci
npm run desktop:dev
```

macOS App：

```sh
npm run tauri -- build --bundles app
```

Windows 便携 EXE（在 Windows 构建）：

```powershell
npm run tauri -- build --no-bundle
```

产物位于 `desktop/src-tauri/target/release/`。GitHub 的“构建桌面启动器”工作流可手动分别构建 Windows x64 和 macOS ARM64；它只 checkout 源码，不能访问维护者的本地游戏目录。首次流程运行前需提交 `Cargo.lock` 和 `package-lock.json`，以固定依赖。

维护者更新已支持的引擎适配描述：

```sh
python3 -B tools/generate_launcher_engine_spec.py --check
```

这一步仅由维护者在本地审计原引擎时使用；用户运行 EXE/App 时没有 Python 依赖。

## 验证

```sh
cd desktop
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

测试覆盖目录名变化与 b/data/外层选择、资源路径安全、版本不兼容、嵌入首页优先、Range/HEAD、gzip 批读取、端口复用与冲突回退、退出释放端口、引擎构建等。默认测试使用临时虚拟资源，不依赖游戏数据。

维护者可让编译出的程序执行无窗口后端检查，不打开游戏或浏览器：

```sh
gta5data-launcher --verify-resources "玩家资源包目录" "游戏目录之外的测试缓存"
```

实际界面选择、浏览器启动、游戏加载及多人体验仍需要用户验证。当前构建未签名；正式公开分发应补 Windows 代码签名及 macOS 签名和公证。

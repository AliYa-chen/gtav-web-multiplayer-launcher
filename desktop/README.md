# GTA5Data 桌面启动器

Tauri 2 原生界面，Rust 后端直接校验资源、生成运行副本并提供本地 HTTP 服务。用户无需安装 Python、Java、Node.js 或 Rust；这些只用于开发和构建。游戏在默认浏览器中运行，建议使用支持 WebGPU 的新版 Chrome 或 Edge。

0.1.2 使用明亮全幅背景与半透明面板，右上“设置”可切换十二张内置背景并记住选择。
启动时及每五分钟读取远程配置，也可手动“检查更新”。公告、版本说明和对应系统的下载链接来自
[`index.json`](https://oss.2t.hk/gtav/index.json)，完整字段示例见 [远程配置说明](../docs/远程启动器配置.md)。
当前线上 JSON 仅含 `oltitle`，因此暂时显示“暂无版本信息”与“暂无公告”；填入真实字段后会动态显示，
启动器不伪造最新版或下载地址。“下载新版”通过浏览器打开经过校验的 HTTPS 链接，不自动安装。

游戏内原生“线上”页使用同一配置中的 `oltitle` 显示状态地址与战局连接信息。
这里只替换已识别线上页的展示，不改变原游戏网络会话标志或资源文件。

0.2.0 接入共同环境和执法策略。时间、天气、雨风与通缉读取服务端状态；客户端抑制独立警察调度，
共同警员只由有效租约的模拟端执行服务器目标。新公共服务要求这些能力，旧启动器需要更新。
共享警力派遣仍限定已核对的公共出生区附近，AI／物理模拟仍使用获授权的客户端引擎。

## 使用

1. Windows 双击 `gta5data-launcher.exe`；macOS 打开 `GTA5Data Launcher.app`。
2. 点击“选择文件夹”，选择自己的游戏资源包。
3. 点击“启动游戏”。首次启动自动完成目录识别、版本校验、运行引擎与字体缓存准备，然后打开浏览器。
4. 在游戏主页选择单人模式，或按 O 加入远程公共战局。测试多人时可在启动器点击“另开一个客户端”。

启动器记住最近成功校验的目录和首个本地端口。关闭启动器会关闭所有由它开启的本地 HTTP 服务；再次启动无需手动运行任何脚本。

0.1.1 修复远端弹道在武器尚未载入时被提前确认、刷新恢复后雷达标记失效未补建的问题。
弹道等待角色和资源就绪，最多保留两秒，完成后才确认；可视轨迹优先从真实枪口或右手位置播放，仍使用零伤害覆盖。
标记每半秒核对原生句柄，失效时重建并恢复地图/雷达可见属性，不重建玩家角色。
启动器内嵌 `client`，更新这类修复需替换 App/EXE，重新启动后自动校验并更新引擎缓存。

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

产物位于 `desktop/src-tauri/target/release/`。GitHub 的“构建桌面启动器”工作流仅允许手动触发，普通提交和标签不会自动编译；需要用户明确要求构建后才运行。它可分别构建 Windows x64 和 macOS ARM64，只 checkout 源码，不能访问维护者的本地游戏目录。首次流程运行前需提交 `Cargo.lock` 和 `package-lock.json`，以固定依赖。

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

实际界面选择、浏览器启动、游戏加载及多人体验仍需要用户验证。

## macOS 签名与公开分发

网站 HTTPS 的 `fullchain.pem`、`privkey.key` 不能用于 macOS 代码签名。公开分发 App 需要 Apple Developer Program 签发的 **Developer ID Application** 证书及对应私钥，还需要向 Apple 提交公证；普通 Apple Development 开发证书只能用于开发测试。当前尚无付费开发者账户和 Developer ID 证书，因此当前 macOS 产物只能标记为 **Development 测试版**，不能保证其他电脑的 Gatekeeper 接受，也不能宣称已完成正式签名和公证。

准备好正式证书后，在维护者自己的 macOS 钥匙串中安装证书和私钥，并通过 `xcrun notarytool store-credentials` 的交互提示保存公证凭据为钥匙串配置。不要把证书私钥、账户密码或 App 专用密码写入仓库、脚本、命令行参数或构建日志。发布脚本只接收证书身份名称和已保存的配置名称：

```sh
cd desktop
bash sign-macos.sh \
  --app 'src-tauri/target/release/bundle/macos/GTA5Data Launcher.app' \
  --identity 'Developer ID Application: 您的名称 (TEAMID)' \
  --keychain-profile 'gta5data-notary'
```

脚本先复制 App 到临时目录，逐层签名内嵌代码与 App，开启 Hardened Runtime 并使用可信时间戳；随后执行严格签名验证、公证提交并等待 `Accepted`、附加及验证公证票据、Gatekeeper 验收。全部通过后才生成 `releases/GTA5Data-Launcher-macos-notarized.zip`。输入 App 不会被改写，任何验收失败都不会生成正式 ZIP；已有输出不会被覆盖。

可加 `--dry-run` 只检查参数并查看流程；它不签名、不连接公证服务，也不证明具备发布资格。没有正式证书时，开发测试必须显式使用另一条流程：

```sh
bash sign-macos.sh --development \
  --app 'src-tauri/target/release/bundle/macos/GTA5Data Launcher.app' \
  --identity 'Apple Development: 您的名称 (TEAMID)'

# 自动构建环境没有任何证书时，仍可做临时的完整性签封。
bash sign-macos.sh --development \
  --app 'src-tauri/target/release/bundle/macos/GTA5Data Launcher.app' \
  --identity -
```

开发流程只输出以 `-development.zip` 结尾的测试包，验证包内签名完整性，不执行公证和公开分发验收。Ad hoc 签封没有开发者身份背书；Apple Development 签名也不能替代 Developer ID 和公证。不要要求玩家全局关闭 Gatekeeper 或移除下载隔离标记来补足发布流程。Windows Authenticode 是独立的代码签名体系，不复用 Apple 或 HTTPS 证书。

参考核对：Clash Verge Rev 的 [v2.5.7 发布流程](https://github.com/clash-verge-rev/clash-verge-rev/blob/ea509b82363a40c3c32e951d7ce9d66d66da411f/.github/workflows/release.yml#L254-L264) 通过 Secrets 提供 Apple 证书、签名身份与公证凭据。用户提供的 2.5.7 ARM64 DMG 内 App 实测为 `Developer ID Application: won fen (JPH3Z7PPBB)`，有 stapled 公证票据，Gatekeeper 返回 `accepted / Notarized Developer ID`。外层 DMG 未附票据不代表内层 App 未公证。它的开源源码不包含这些私有证书凭据；Tauri 更新包签名密钥也不等于 Apple 代码签名证书。本核对没有运行 Clash Verge，也没有复制其私钥或证书到本项目。

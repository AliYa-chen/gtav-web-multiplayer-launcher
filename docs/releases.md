# Automated releases

[English](#english) | [简体中文](#简体中文)

## English

One workflow, [`.github/workflows/release.yml`](../.github/workflows/release.yml), runs after code is merged to `main`. It reads the component version and the matching Markdown file under `release-notes/`, builds verified assets, and publishes independently versioned launcher and server releases. Windows and macOS do not need separate workflows.

| Component | Version source | Update-note file | Outputs |
| --- | --- | --- | --- |
| Launcher | `desktop/package.json`, npm lock, Cargo manifests/lock and `tauri.conf.json` must agree | `release-notes/launcher-vX.Y.Z.md` | Windows x64 EXE, macOS ARM64 App ZIP, SHA-256 and provenance manifest |
| Server | `VERSION` in `server/src/main/java/offline/multiplayer/Main.java` | `release-notes/server-vX.Y.Z.md` | Java 17 JAR, deployment ZIP, SHA-256 and provenance manifest |

### Maintain one update file per component version

When changing launcher runtime code, increment its version consistently and add/update its corresponding release-note file. When changing server runtime code, increment the server version and add/update its own file. A client-only fix does not require a server version change. Files must include nonempty `## English` followed by `## 简体中文`; the text is read as data, never executed as shell commands.

Describe the concrete feature or bug, resulting behavior, affected component, compatibility and relevant checks. The workflow never invents release notes or updates versions itself.

The plan fingerprints each component's Git source. A published unchanged version is skipped; pure documentation changes do not recompile it. If runtime source changes under an already published version, the plan fails and asks for that component's version to be increased. It does not overwrite an older binary with a newly compiled file under the same version.

### Build and publish

1. Validate source-only repository contents, component versions and bilingual update MD files.
2. Build Windows x64 and macOS explicitly for `aarch64-apple-darwin`; check actual executable architecture/version and the macOS development signature. macOS is not notarized.
3. Build the Java server separately using Java 17 and package its JAR, scripts and deployment instructions without game-derived world data.
4. Create a draft per component, upload the full asset set, verify GitHub SHA-256/size against the local manifest, then make that release public.
5. Record the exact build commit, source fingerprint and file hashes in `provenance-<tag>.json` and `SHA256SUMS-<tag>.txt`.

Release tags are `launcher-vX.Y.Z` and `server-vX.Y.Z`, with category-specific titles and English notes before Chinese. Launcher publication waits for both platforms; server publication is independent. GitHub automatically supplies source ZIP/TAR downloads as well.

A failed build is not published as a finished binary release. Drafts with matching provenance can resume; a tag, draft or existing asset belonging to a different commit is not silently replaced. Runs are serialized so a later merge does not interrupt an upload already in progress.

### Deployment responsibilities

The launcher artifacts are ready for download from GitHub. Deployment of the launcher and portal, and updating `remote-config/index.php`, remain separate operations performed only when explicitly requested. The workflow does not write, commit or publish website configuration.

Server changes are automatically deployed to the US after the server release succeeds. The deploy job checks provenance and SSH host identity, verifies no active players are interrupted, backs up current JAR/configuration, replaces the JAR atomically, and checks health, WSS snapshots and heartbeats. The US experimental route precedes its main route. China is unreachable from foreign runners and is deployed from the maintainer machine only when explicitly requested. Identical installed Java classes are verified without restarting; failure restores the old JAR. See [automatic server deployment](server-deployment-automation.md).

### Credentials and resource boundary

Release publishing uses the repository's scoped `GITHUB_TOKEN`; server access uses Actions Secrets documented in the deployment guide. Credentials and production certificate keys never enter the source, update notes or artifacts. Neither build jobs nor ordinary JAR deployment modify player game resources. Release assets do not include the original engine, game packages or extracted world geometry.

## 简体中文

代码合并到 `main` 后，由 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 这一个工作流读取组件版本和 `release-notes/` 中的本次更新 MD，构建核验产物并分类发布。Windows 和 macOS 不再分成两个工作流。

| 组件 | 版本来源 | 本次更新说明 | 产物 |
| --- | --- | --- | --- |
| 启动器 | `desktop/package.json`、npm lock、Cargo 清单/lock 与 `tauri.conf.json` 保持一致 | `release-notes/launcher-vX.Y.Z.md` | Windows x64 EXE、macOS ARM64 App ZIP、SHA-256 和来源记录 |
| 服务端 | `server/src/main/java/offline/multiplayer/Main.java` 中的 `VERSION` | `release-notes/server-vX.Y.Z.md` | Java 17 JAR、部署 ZIP、SHA-256 和来源记录 |

### 每个组件版本一份更新 MD

修改启动器运行代码时，同步升启动器版本，并维护对应更新说明；修改服务端运行代码时，升服务端版本并写自己的更新说明。只修客户端不需要升服务端版本。MD 必须包含非空的 `## English`，然后是 `## 简体中文`；说明只当数据读取，不作为 shell 命令执行。

写清完成什么功能、修复什么问题、改变后的行为、影响组件、兼容条件及实际检查。工作流不自动编造说明，也不自行改版本号。

计划步骤按组件计算 Git 源码指纹：同版本已发布且源码未变时跳过，纯文档改动不触发重新编译。已发布版本下的运行代码发生变更会明确失败，要求升对应组件版本，不把新编译文件覆盖到旧版本。

### 自动构建与发布

1. 检查仓库只含允许提交的源码、组件版本与双语更新 MD。
2. 构建 Windows x64；macOS 显式构建 `aarch64-apple-darwin`，核对真实架构、版本及开发签名完整性。macOS 尚未公证。
3. 服务端独立使用 Java 17 编译，打包 JAR、启动脚本与部署说明，不包含游戏派生世界数据。
4. 每个组件先创建草稿，上传完整附件，核对 GitHub SHA-256/大小，全部通过后再公开。
5. `provenance-<tag>.json` 和 `SHA256SUMS-<tag>.txt` 记录精确构建提交、源码指纹与文件哈希。

标签分别为 `launcher-vX.Y.Z`、`server-vX.Y.Z`，标题按组件分类，更新说明英文在前、中文在后。启动器等待两平台均构建成功，服务端独立发布；GitHub 还会提供源码 ZIP/TAR。

失败构建不会发布成完成的二进制 Release。来源一致的草稿可以恢复；标签、草稿或已有附件属于不同提交时，不静默覆盖。工作流串行排队，后续合并不打断正在上传的发布。

### 部署分工

GitHub 提供启动器的最新构建产物。启动器/门户部署及 `remote-config/index.php` 更新在单独明确要求后处理，工作流不写入、提交或发布网站配置。

服务端 Release 成功后自动部署美国线路：核对来源和 SSH 主机身份，避免中断活跃玩家，备份原 JAR/配置并原子替换，检查健康、WSS 快照和心跳。先美国实验线路，再美国正式线路。中国服务器无法从国外访问，待另行明确要求后通过维护者本机部署；已安装 class 字节一致时只核验不重启，失败恢复原 JAR。详见[服务端自动部署](server-deployment-automation.md#简体中文)。

### 凭据与资源边界

Release 使用仓库作用域的 `GITHUB_TOKEN`，服务端使用部署文档列出的 Actions Secrets。登录凭据和生产证书私钥不进入源码、更新说明或附件。构建和常规 JAR 部署均不修改玩家游戏资源，发布包不包含原引擎、游戏数据包或提取的世界几何。

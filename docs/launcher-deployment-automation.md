# Launcher download deployment

[English](#english) | [简体中文](#简体中文)

## English

The existing `release.yml` pipeline now builds both desktop platforms, publishes their immutable GitHub Release, and deploys the verified Windows EXE, macOS ARM64 ZIP and generated `index.php` to the 1Panel download site. The public origin is `https://oss.2t.hk/gtav`; the site directory is `/opt/1panel/www/sites/oss.2t.hk/index/gtav`. The separate portal website is outside this job.

### Source and configuration

`remote-config/index.php` is the maintained configuration template. The preparation tool keeps its site, server routes, announcements, CORS policy and other fields; it replaces only the launcher version, English/Chinese update notes and the two verified download URLs/hashes in a deployment copy. Generated PHP and downloaded binaries stay in ignored working directories; the workflow does not make automatic Git commits.

A launcher source change requires a new component version and matching bilingual update MD. Both platform builds and the complete Release must succeed before deployment. A template-only or pipeline change reuses the existing Release after verifying its original commit, current launcher source fingerprint, real platform/version headers, all seven GitHub asset digests and provenance. A changed binary is never relabelled under a published version. Re-running the workflow can retry deployment without rebuilding an unchanged release.

### Credentials and PHP

Configure repository **Settings → Secrets and variables → Actions → Repository secrets**:

| Secret | Meaning |
| --- | --- |
| `GTA_OSS_SSH_HOST` | Download server SSH hostname or IP. |
| `GTA_OSS_SSH_PORT` | Existing SSH port. |
| `GTA_OSS_SSH_USER` | Account permitted to deploy into the download directory. |
| `GTA_OSS_SSH_PASSWORD` | SSH authentication password. |
| `GTA_OSS_SSH_KNOWN_HOSTS` | Host key confirmed through an existing trusted connection. |

Only the deployment step receives these values as environment variables. The workflow keeps SSH host-key and public HTTPS certificate verification enabled and does not print credentials. The current 1Panel PHP runtime is the existing `PHP85` container, used to lint and render the candidate through standard input; no panel, PHP, proxy or service configuration changes are needed.

### Transfer through a public acceleration source

The download server fetches public Release files through the configured HTTPS acceleration prefixes (`GTA_OSS_DOWNLOAD_MIRRORS`: `https://gh-proxy.com/`, `https://ghfast.top/`, `https://gh-proxy.org/`), trying them in order. Only public repository/tag/file URLs go to this service; no GitHub token or SSH credential is sent. Every result must match the original GitHub size and SHA-256 before it becomes a staged package. Failed or mismatched mirror responses try the next source, then GitHub, then bounded SFTP upload. The mirror accelerates transport and cannot change the accepted package bytes. Existing same-version, same-hash packages are reused for configuration-only updates. SSH compression, keepalive and transfer timeouts also apply.

### Activation and retirement

1. Validate the published packages and generated configuration before opening a server connection.
2. Hold a remote deployment lock and validate ordinary, symlink-free paths. Stage and back up files outside the public directory under `/opt/gta5data-launcher-deploy/`.
3. Fetch or upload and verify both packages, atomically install them, and hash the bytes served by their public HTTPS URLs before publishing the new version in configuration.
4. Lint and render the PHP candidate, then atomically replace `index.php`. Check the served JSON, version, bilingual notes, URLs and hashes against the candidate; verify both downloads again.
5. Only after successful verification, remove strictly older `GTA5Data-Launcher-Windows-x64-vX.Y.Z.exe` and `GTA5Data-Launcher-macOS-arm64-vX.Y.Z-development.zip` files from the public directory. Keep their private rollback backups; preserve unrelated files and newer versions.
6. If verification fails, restore the previous configuration and affected files. Reject downgrades, same-version files with different hashes and symbolic links. Do not modify player game resources.

The `launcher-deployment-audit` Actions artifact records the published source, version, hashes, activation, retirement and rollback outcome. Server deployment remains independent: US lanes run through GitHub, China lanes wait for an explicit local deployment request.

## 简体中文

既有 `release.yml` 流水线现按顺序自动构建两个桌面平台、发布不可覆盖的 GitHub Release，再将已核验的 Windows EXE、macOS ARM64 ZIP 和生成的 `index.php` 部署到 1Panel 下载站。公开入口为 `https://oss.2t.hk/gtav`，目录为 `/opt/1panel/www/sites/oss.2t.hk/index/gtav`。独立门户网站不属于此任务。

### 源码与配置

`remote-config/index.php` 是维护用配置模板。准备工具保留官网、服务器线路、公告、CORS 及其他字段，只在部署副本中替换启动器版本、中英文更新说明、两个下载地址和真实文件哈希。生成的 PHP 和下载附件保存在被忽略的工作目录，工作流不自动提交 Git 配置改动。

启动器运行源码变化时，升组件版本并写对应双语更新 MD。两个平台及完整 Release 全部成功后才能部署；仅修改配置模板或流水线时，核对原构建提交、当前启动器源码指纹、真实平台/版本、七个 GitHub 附件摘要和来源后复用已发布安装包。不能把改过的程序重新标为已发布版本。重新运行同一工作流可重试部署，无需重建源码未变的版本。

### 凭据与 PHP

仓库 **Settings → Secrets and variables → Actions → Repository secrets** 保存 `GTA_OSS_SSH_HOST`、`GTA_OSS_SSH_PORT`、`GTA_OSS_SSH_USER`、`GTA_OSS_SSH_PASSWORD` 和经过可信连接确认的 `GTA_OSS_SSH_KNOWN_HOSTS`。仅部署步骤通过环境变量读取；保持 SSH 指纹及 HTTPS 证书校验，不输出凭据。

当前 PHP 由既有 `PHP85` 容器运行，通过标准输入检查候选配置的语法并输出 JSON；无需修改 1Panel、PHP、代理或服务设置。

### 公开加速源与传输

下载服务器通过配置的 HTTPS 加速入口主动拉取公开 Release 文件，`GTA_OSS_DOWNLOAD_MIRRORS` 按顺序配置 `https://gh-proxy.com/`、`https://ghfast.top/`、`https://gh-proxy.org/`。加速源只收到公开的仓库、标签和文件地址，不接收 GitHub Token 或 SSH 凭据。每个结果必须符合原 GitHub 文件大小与 SHA-256 才能进入暂存安装；失败或哈希不符时尝试下一个入口，全部失败后尝试 GitHub 直连与有超时的 SFTP 上传。镜像只加速传输，不能改变实际接受的程序字节。仅修改配置时复用已存在且同版本、同哈希的安装包，并保留 SSH 压缩、心跳及传输超时。

### 启用与清理

1. 连接前核验已发布安装包及生成配置。
2. 持有服务器部署锁，检查普通文件和无符号链接路径。在公共目录之外的 `/opt/gta5data-launcher-deploy/` 暂存并备份。
3. 拉取或上传、核验并原子安装两个新包，先通过公开 HTTPS 下载核对真实字节和哈希，再公布新版本。
4. 检查 PHP 语法及输出，原子替换 `index.php`；核对线上 JSON、版本、双语说明、地址及哈希，再核对两个下载。
5. 全部成功后，只移除公共目录中版本严格较低、文件名精确匹配的 Windows EXE 和 macOS 开发 ZIP；站外保留回滚备份，无关文件与更高版本保留。
6. 检查失败恢复原配置及相关文件；拒绝降级、同版本不同哈希和符号链接。玩家游戏资源始终只读。

Actions 的 `launcher-deployment-audit` 附件记录发布来源、版本、哈希、启用、旧包清理及回滚结果。游戏服务端部署独立：美国线路走 GitHub，中国线路等待明确的本机部署指令。

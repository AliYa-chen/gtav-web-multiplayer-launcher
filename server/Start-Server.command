#!/bin/sh
# macOS 双击启动；Linux 也可通过 sh Start-Server.command 运行。
cd "$(dirname "$0")" || exit 1
if ! command -v java >/dev/null 2>&1; then
    printf '%s\n' '未找到 Java，请先安装 Java 17 或更新版本。'
    exit 1
fi
exec java -jar multiplayer-server.jar "$@"

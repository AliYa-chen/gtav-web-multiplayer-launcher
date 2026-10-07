#!/bin/sh
# Linux 前台启动公共战局服务；日志输出到终端。
cd "$(dirname "$0")" || exit 1
if ! command -v java >/dev/null 2>&1; then
    printf '%s\n' '未找到 Java，请先安装 Java 17 或更新版本。'
    exit 1
fi
exec java -jar multiplayer-server.jar "$@"

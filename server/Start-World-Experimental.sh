#!/bin/sh
set -eu
server_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$server_directory"
exec java -jar multiplayer-world-experimental.jar --host 0.0.0.0 --port 47486 --max-clients 8 "$@"

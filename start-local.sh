#!/bin/sh
# Build and restart this checkout's local development server and launcher.
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec python3 -B "$project_dir/tools/local_development.py" "$@"

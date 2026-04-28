#!/usr/bin/env sh
set -eu

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$PROJECT_DIR/curses/run.sh" "$@"

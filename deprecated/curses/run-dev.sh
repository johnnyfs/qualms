#!/usr/bin/env sh
set -eu

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PROJECT_ROOT="$(CDPATH= cd -- "$PROJECT_DIR/.." && pwd)"

exec uv run --project "$PROJECT_ROOT" python "$PROJECT_DIR/dark_qualms_story.py" --editor "$@"

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


DEFAULT_MODEL = "anthropic:claude-opus-4-1-20250805"
DEFAULT_MAX_TOOL_CALLS = 40


@dataclass(frozen=True)
class CoauthorConfig:
    model: str
    anthropic_api_key: str | None
    openai_api_key: str | None
    max_tool_calls: int = DEFAULT_MAX_TOOL_CALLS


def load_coauthor_config(start: Path | None = None) -> CoauthorConfig:
    load_dotenv(find_dotenv(start or Path.cwd()))
    return CoauthorConfig(
        model=os.environ.get("QUALMS_COAUTHOR_MODEL", DEFAULT_MODEL),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY"),
        openai_api_key=os.environ.get("OPENAI_API_KEY"),
        max_tool_calls=parse_int_env("QUALMS_COAUTHOR_MAX_TOOL_CALLS", DEFAULT_MAX_TOOL_CALLS),
    )


def parse_int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(1, value)


def find_dotenv(start: Path) -> Path | None:
    current = start if start.is_dir() else start.parent
    for directory in (current, *current.parents):
        candidate = directory / ".env"
        if candidate.exists():
            return candidate
    return None


def load_dotenv(path: Path | None) -> None:
    if path is None:
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        os.environ[key] = strip_env_quotes(value.strip())


def strip_env_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value

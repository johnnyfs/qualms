#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def load_legacy_module():
    module_path = ROOT / "curses" / "dark_qualms_story.py"
    spec = importlib.util.spec_from_file_location("dark_qualms_story", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load dark_qualms_story.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser(description="Convert legacy story_systems.json to Qualms YAML")
    parser.add_argument("input", nargs="?", type=Path, default=ROOT / "stories" / "stellar" / "story_systems.json")
    parser.add_argument("output", nargs="?", type=Path, default=ROOT / "stories" / "stellar" / "story.qualms.yaml")
    args = parser.parse_args()

    legacy = load_legacy_module()
    from qualms.legacy import write_legacy_world_yaml

    data_file = legacy.resolve_data_file(args.input)
    world = legacy.load_world(data_file)
    write_legacy_world_yaml(world, args.output)
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

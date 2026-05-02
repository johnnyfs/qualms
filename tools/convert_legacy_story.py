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
    parser.add_argument("input", type=Path, help="Legacy story_systems.json file or directory")
    parser.add_argument("output", nargs="?", type=Path, help="Output story.qualms.yaml path")
    args = parser.parse_args()

    legacy = load_legacy_module()
    from qualms.legacy import write_legacy_world_yaml

    data_file = args.input / "story_systems.json" if args.input.exists() and args.input.is_dir() else args.input
    world = legacy.load_world(data_file)
    output = args.output or data_file.with_name("story.qualms.yaml")
    write_legacy_world_yaml(world, output)
    print(f"wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

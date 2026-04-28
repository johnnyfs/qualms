#!/usr/bin/env python3
from __future__ import annotations

import argparse
import curses
import json
import re
import textwrap
from curses import ascii
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = PROJECT_ROOT / "stories" / "stellar" / "story_systems.json"
ORBITAL_TYPES = {"Planet", "Moon", "Station"}
OPTION_KINDS = {"Bar", "Tourist Destination", "Destination"}
DETAIL_KINDS = {"Examine", "Take"}
MAX_HOP_DISTANCE_AU = 350000.0
MAP_WIDTH = 58
MAP_HEIGHT = 17
DEFAULT_HOP_DISTANCE_AU = 200000.0


@dataclass(frozen=True)
class Detail:
    kind: str
    name: str
    description: str


@dataclass(frozen=True)
class LandingOption:
    kind: str
    name: str
    description: str
    details: tuple[Detail, ...] = ()
    destinations: tuple[LandingOption, ...] = ()


@dataclass(frozen=True)
class Orbital:
    id: str
    name: str
    type: str
    description: str
    landing_options: tuple[LandingOption, ...]
    parent: str | None = None


@dataclass(frozen=True)
class System:
    id: str
    name: str
    star_type: str
    description: str
    position_au: tuple[float, float]
    hops: tuple[str, ...]
    orbitals: tuple[Orbital, ...]


@dataclass(frozen=True)
class StoryWorld:
    start_system: str
    systems: tuple[System, ...]

    def system_by_id(self, system_id: str) -> System:
        for system in self.systems:
            if system.id == system_id:
                return system
        raise KeyError(system_id)


@dataclass
class GameState:
    system_id: str
    editor_enabled: bool = False
    view: str = "system"
    map_return_view: str = "system"
    orbital_id: str | None = None
    docked_path: list[int] = field(default_factory=list)
    destination_path: list[int] = field(default_factory=list)
    detail_index: int | None = None
    last_system_id: str | None = None
    last_orbital_by_system: dict[str, str] = field(default_factory=dict)
    message: str = ""


def blank_world_raw() -> dict:
    return {
        "start_system": "empty-system",
        "systems": [
            {
                "id": "empty-system",
                "name": "Empty System",
                "star_type": "Unspecified",
                "description": "Nothing has been defined here yet.",
                "position_au": [0, 0],
                "hops": [],
                "orbitals": [],
            }
        ],
    }


def resolve_data_file(path: Path) -> Path:
    if path.exists() and path.is_dir():
        return path / "story_systems.json"
    if not path.exists() and path.suffix.lower() != ".json":
        return path / "story_systems.json"
    return path


def read_or_create_raw(path: Path) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or not path.read_text(encoding="utf-8").strip():
        raw = blank_world_raw()
        write_raw_world(path, raw)
        return raw

    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw == {}:
        raw = blank_world_raw()
        write_raw_world(path, raw)
    return raw


def write_raw_world(path: Path, raw: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")


def require_string(data: dict, field: str, context: str) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context}.{field} must be a non-empty string")
    return value


def require_list(data: dict, field: str, context: str) -> list:
    value = data.get(field)
    if not isinstance(value, list):
        raise ValueError(f"{context}.{field} must be a list")
    return value


def require_position(data: dict, context: str) -> tuple[float, float]:
    value = data.get("position_au")
    if (
        not isinstance(value, list)
        or len(value) != 2
        or not all(isinstance(item, (int, float)) for item in value)
    ):
        raise ValueError(f"{context}.position_au must be a two-number list")
    return float(value[0]), float(value[1])


def load_landing_options(raw_options: list, context: str) -> tuple[LandingOption, ...]:
    if len(raw_options) > 9:
        raise ValueError(f"{context} must contain no more than 9 destinations")

    options: list[LandingOption] = []
    for option_index, option_raw in enumerate(raw_options):
        option_context = f"{context}[{option_index}]"
        if not isinstance(option_raw, dict):
            raise ValueError(f"{option_context} must be an object")
        kind = require_string(option_raw, "kind", option_context)
        if kind not in OPTION_KINDS:
            raise ValueError(f"{option_context}.kind must be one of {sorted(OPTION_KINDS)}")

        child_raws = option_raw.get("destinations", [])
        if not isinstance(child_raws, list):
            raise ValueError(f"{option_context}.destinations must be a list")
        detail_raws = option_raw.get("details", [])
        if not isinstance(detail_raws, list):
            raise ValueError(f"{option_context}.details must be a list")

        options.append(
            LandingOption(
                kind=kind,
                name=require_string(option_raw, "name", option_context),
                description=require_string(option_raw, "description", option_context),
                details=load_details(detail_raws, f"{option_context}.details"),
                destinations=load_landing_options(child_raws, f"{option_context}.destinations"),
            )
        )
    return tuple(options)


def load_details(raw_details: list, context: str) -> tuple[Detail, ...]:
    if len(raw_details) > 9:
        raise ValueError(f"{context} must contain no more than 9 details")

    details: list[Detail] = []
    for detail_index, detail_raw in enumerate(raw_details):
        detail_context = f"{context}[{detail_index}]"
        if not isinstance(detail_raw, dict):
            raise ValueError(f"{detail_context} must be an object")
        kind = require_string(detail_raw, "kind", detail_context)
        if kind not in DETAIL_KINDS:
            raise ValueError(f"{detail_context}.kind must be one of {sorted(DETAIL_KINDS)}")
        details.append(
            Detail(
                kind=kind,
                name=require_string(detail_raw, "name", detail_context),
                description=require_string(detail_raw, "description", detail_context),
            )
        )
    return tuple(details)


def load_world(path: Path = DATA_PATH) -> StoryWorld:
    raw = read_or_create_raw(path)
    if not isinstance(raw, dict):
        raise ValueError("root must be an object")

    start_system = require_string(raw, "start_system", "root")
    systems: list[System] = []

    for system_index, system_raw in enumerate(require_list(raw, "systems", "root")):
        context = f"systems[{system_index}]"
        if not isinstance(system_raw, dict):
            raise ValueError(f"{context} must be an object")

        orbitals: list[Orbital] = []
        orbital_ids: set[str] = set()
        orbital_raws = require_list(system_raw, "orbitals", context)
        if len(orbital_raws) > 9:
            raise ValueError(f"{context}.orbitals must contain no more than 9 destinations")

        for orbital_index, orbital_raw in enumerate(orbital_raws):
            orbital_context = f"{context}.orbitals[{orbital_index}]"
            if not isinstance(orbital_raw, dict):
                raise ValueError(f"{orbital_context} must be an object")

            orbital_id = require_string(orbital_raw, "id", orbital_context)
            if orbital_id in orbital_ids:
                raise ValueError(f"{orbital_context}.id duplicates {orbital_id}")
            orbital_ids.add(orbital_id)

            orbital_type = require_string(orbital_raw, "type", orbital_context)
            if orbital_type not in ORBITAL_TYPES:
                raise ValueError(f"{orbital_context}.type must be one of {sorted(ORBITAL_TYPES)}")

            options = load_landing_options(require_list(orbital_raw, "landing_options", orbital_context), f"{orbital_context}.landing_options")

            parent = orbital_raw.get("parent")
            if parent is not None and (not isinstance(parent, str) or not parent.strip()):
                raise ValueError(f"{orbital_context}.parent must be a non-empty string when present")

            orbitals.append(
                Orbital(
                    id=orbital_id,
                    name=require_string(orbital_raw, "name", orbital_context),
                    type=orbital_type,
                    description=require_string(orbital_raw, "description", orbital_context),
                    parent=parent,
                    landing_options=options,
                )
            )

        systems.append(
            System(
                id=require_string(system_raw, "id", context),
                name=require_string(system_raw, "name", context),
                star_type=require_string(system_raw, "star_type", context),
                description=str(system_raw.get("description", "")),
                position_au=require_position(system_raw, context),
                hops=tuple(require_string({"hop": hop}, "hop", f"{context}.hops[{index}]") for index, hop in enumerate(require_list(system_raw, "hops", context))),
                orbitals=tuple(orbitals),
            )
        )

    world = StoryWorld(start_system=start_system, systems=tuple(systems))
    world.system_by_id(start_system)
    system_ids = {system.id for system in world.systems}
    if len(system_ids) != len(world.systems):
        raise ValueError("system IDs must be unique")

    for system in world.systems:
        if len(system.hops) > 9:
            raise ValueError(f"{system.id}.hops must contain no more than 9 destinations")

        ids = {orbital.id for orbital in system.orbitals}
        for orbital in system.orbitals:
            if orbital.parent is not None and orbital.parent not in ids:
                raise ValueError(f"{system.id}.{orbital.id}.parent references unknown orbital {orbital.parent}")
            if orbital.type == "Moon" and orbital.parent is None:
                raise ValueError(f"{system.id}.{orbital.id} is a Moon and must define parent")

        for hop_id in system.hops:
            if hop_id not in system_ids:
                raise ValueError(f"{system.id}.hops references unknown system {hop_id}")

            hop_system = world.system_by_id(hop_id)
            if system.id not in hop_system.hops:
                raise ValueError(f"{system.id}.hops to {hop_id} must be reciprocal")

            if system_distance_au(system, hop_system) > MAX_HOP_DISTANCE_AU:
                raise ValueError(f"{system.id}.hops to {hop_id} exceeds {MAX_HOP_DISTANCE_AU:.0f} AU")
    return world


def orbital_by_id(system: System, orbital_id: str) -> Orbital:
    for orbital in system.orbitals:
        if orbital.id == orbital_id:
            return orbital
    raise KeyError(orbital_id)


def system_distance_au(first: System, second: System) -> float:
    dx = second.position_au[0] - first.position_au[0]
    dy = second.position_au[1] - first.position_au[1]
    return (dx * dx + dy * dy) ** 0.5


def format_signed_au(value: float) -> str:
    return f"{value:+.0f} AU"


def sorted_hops(world: StoryWorld, system: System) -> list[System]:
    hops = [world.system_by_id(hop_id) for hop_id in system.hops]
    return sorted(hops, key=lambda hop: system_distance_au(system, hop))


def world_to_raw(world: StoryWorld) -> dict:
    return {
        "start_system": world.start_system,
        "systems": [
            {
                "id": system.id,
                "name": system.name,
                "star_type": system.star_type,
                "description": system.description,
                "position_au": [system.position_au[0], system.position_au[1]],
                "hops": list(system.hops),
                "orbitals": [
                    {
                        "id": orbital.id,
                        "name": orbital.name,
                        "type": orbital.type,
                        "description": orbital.description,
                        **({"parent": orbital.parent} if orbital.parent else {}),
                        "landing_options": [
                            landing_option_to_raw(option) for option in orbital.landing_options
                        ],
                    }
                    for orbital in system.orbitals
                ],
            }
            for system in world.systems
        ],
    }


def landing_option_to_raw(option: LandingOption) -> dict:
    return {
        "kind": option.kind,
        "name": option.name,
        "description": option.description,
        "details": [
            {
                "kind": detail.kind,
                "name": detail.name,
                "description": detail.description,
            }
            for detail in option.details
        ],
        "destinations": [landing_option_to_raw(child) for child in option.destinations],
    }


def save_and_reload(path: Path, raw: dict) -> StoryWorld:
    write_raw_world(path, raw)
    return load_world(path)


def slugify(value: str, fallback: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or fallback


def unique_id(existing: set[str], desired: str) -> str:
    candidate = desired
    suffix = 2
    while candidate in existing:
        candidate = f"{desired}-{suffix}"
        suffix += 1
    return candidate


def system_raw_by_id(raw: dict, system_id: str) -> dict:
    for system in raw["systems"]:
        if system["id"] == system_id:
            return system
    raise KeyError(system_id)


def orbital_raw_by_id(system_raw: dict, orbital_id: str) -> dict:
    for orbital in system_raw["orbitals"]:
        if orbital["id"] == orbital_id:
            return orbital
    raise KeyError(orbital_id)


def add_orbital(
    world: StoryWorld,
    path: Path,
    system_id: str,
    orbital_type: str,
    name: str,
    description: str,
    parent: str | None = None,
) -> StoryWorld:
    raw = world_to_raw(world)
    system_raw = system_raw_by_id(raw, system_id)
    if len(system_raw["orbitals"]) >= 9:
        raise ValueError("system already has 9 orbitals")
    if orbital_type not in ORBITAL_TYPES:
        raise ValueError(f"orbital type must be one of {sorted(ORBITAL_TYPES)}")
    if orbital_type == "Moon" and not parent:
        raise ValueError("moon must have a parent")
    existing = {orbital["id"] for orbital in system_raw["orbitals"]}
    orbital = {
        "id": unique_id(existing, slugify(name, "orbital")),
        "name": name,
        "type": orbital_type,
        "description": description,
        "landing_options": [],
    }
    if parent:
        orbital["parent"] = parent
    system_raw["orbitals"].append(orbital)
    return save_and_reload(path, raw)


def delete_orbital(world: StoryWorld, path: Path, system_id: str, orbital_id: str) -> StoryWorld:
    raw = world_to_raw(world)
    system_raw = system_raw_by_id(raw, system_id)
    dependents = [orbital["name"] for orbital in system_raw["orbitals"] if orbital.get("parent") == orbital_id]
    if dependents:
        raise ValueError("delete child orbitals first: " + ", ".join(dependents))
    for index, orbital in enumerate(system_raw["orbitals"]):
        if orbital["id"] == orbital_id:
            del system_raw["orbitals"][index]
            return save_and_reload(path, raw)
    raise ValueError("orbital no longer exists")
    return save_and_reload(path, raw)


def landing_destination_list_raw(orbital_raw: dict, destination_path: list[int]) -> list:
    destinations = orbital_raw["landing_options"]
    for index in destination_path:
        destinations = destinations[index].setdefault("destinations", [])
    return destinations


def landing_destination_raw(orbital_raw: dict, destination_path: list[int]) -> dict:
    if not destination_path:
        raise ValueError("destination path is empty")
    destinations = orbital_raw["landing_options"]
    current = destinations[destination_path[0]]
    for index in destination_path[1:]:
        destinations = current.setdefault("destinations", [])
        current = destinations[index]
    return current


def add_landing_destination(
    world: StoryWorld,
    path: Path,
    system_id: str,
    orbital_id: str,
    parent_path: list[int],
    name: str,
    description: str,
) -> StoryWorld:
    raw = world_to_raw(world)
    orbital_raw = orbital_raw_by_id(system_raw_by_id(raw, system_id), orbital_id)
    destinations = landing_destination_list_raw(orbital_raw, parent_path)
    if len(destinations) >= 9:
        raise ValueError("destination already has 9 child destinations")
    destinations.append(
        {
            "kind": "Destination",
            "name": name,
            "description": description,
            "destinations": [],
        }
    )
    return save_and_reload(path, raw)


def add_detail(
    world: StoryWorld,
    path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    name: str,
    description: str,
) -> StoryWorld:
    raw = world_to_raw(world)
    orbital_raw = orbital_raw_by_id(system_raw_by_id(raw, system_id), orbital_id)
    destination_raw = landing_destination_raw(orbital_raw, destination_path)
    details = destination_raw.setdefault("details", [])
    if len(details) >= 9:
        raise ValueError("destination already has 9 details")
    details.append(
        {
            "kind": "Examine",
            "name": name,
            "description": description,
        }
    )
    return save_and_reload(path, raw)


def delete_detail(
    world: StoryWorld,
    path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    detail_index: int,
) -> StoryWorld:
    raw = world_to_raw(world)
    orbital_raw = orbital_raw_by_id(system_raw_by_id(raw, system_id), orbital_id)
    destination_raw = landing_destination_raw(orbital_raw, destination_path)
    details = destination_raw.setdefault("details", [])
    if detail_index < 0 or detail_index >= len(details):
        raise ValueError("detail number is out of range")
    del details[detail_index]
    return save_and_reload(path, raw)


def add_system(
    world: StoryWorld,
    path: Path,
    current_system_id: str,
    direction: str,
    name: str,
    description: str,
) -> StoryWorld:
    raw = world_to_raw(world)
    current_raw = system_raw_by_id(raw, current_system_id)
    if len(current_raw["hops"]) >= 9:
        raise ValueError("system already has 9 jump points")
    dx, dy = direction_vector(direction)
    new_position = [
        float(current_raw["position_au"][0]) + dx * DEFAULT_HOP_DISTANCE_AU,
        float(current_raw["position_au"][1]) + dy * DEFAULT_HOP_DISTANCE_AU,
    ]
    existing = {system["id"] for system in raw["systems"]}
    new_id = unique_id(existing, slugify(name, "system"))
    current_raw["hops"].append(new_id)
    raw["systems"].append(
        {
            "id": new_id,
            "name": name,
            "star_type": "Unspecified",
            "description": description,
            "position_au": new_position,
            "hops": [current_system_id],
            "orbitals": [],
        }
    )
    return save_and_reload(path, raw)


def edit_system(world: StoryWorld, path: Path, system_id: str, name: str, description: str) -> StoryWorld:
    raw = world_to_raw(world)
    system_raw = system_raw_by_id(raw, system_id)
    system_raw["name"] = name
    system_raw["description"] = description
    return save_and_reload(path, raw)


def edit_orbital(
    world: StoryWorld,
    path: Path,
    system_id: str,
    orbital_id: str,
    name: str,
    description: str,
) -> StoryWorld:
    raw = world_to_raw(world)
    orbital_raw = orbital_raw_by_id(system_raw_by_id(raw, system_id), orbital_id)
    orbital_raw["name"] = name
    orbital_raw["description"] = description
    return save_and_reload(path, raw)


def edit_landing_destination(
    world: StoryWorld,
    path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    name: str,
    description: str,
) -> StoryWorld:
    raw = world_to_raw(world)
    orbital_raw = orbital_raw_by_id(system_raw_by_id(raw, system_id), orbital_id)
    option_raw = landing_destination_raw(orbital_raw, destination_path)
    option_raw["name"] = name
    option_raw["description"] = description
    return save_and_reload(path, raw)


def direction_vector(direction: str) -> tuple[float, float]:
    normalized = direction.strip().lower()
    vectors = {
        "n": (0.0, 1.0),
        "ne": (0.7071, 0.7071),
        "e": (1.0, 0.0),
        "se": (0.7071, -0.7071),
        "s": (0.0, -1.0),
        "sw": (-0.7071, -0.7071),
        "w": (-1.0, 0.0),
        "nw": (-0.7071, 0.7071),
    }
    if normalized not in vectors:
        raise ValueError("direction must be N, NE, E, SE, S, SW, W, or NW")
    return vectors[normalized]


def destination_status(orbital: Orbital) -> str:
    if orbital.type == "Station":
        return f"Approaching station: {orbital.name}"
    return f"Orbiting {orbital.type.lower()}: {orbital.name}"


def orbital_type_label(system: System, orbital: Orbital) -> str:
    if orbital.type != "Moon" or not orbital.parent:
        return orbital.type

    try:
        parent = orbital_by_id(system, orbital.parent)
    except KeyError:
        return "Moon"
    return f"Moon of {parent.name}"


def centered_window(
    stdscr: curses.window,
    width: int,
    lines: Iterable[str],
    bottom_margin: int = 0,
) -> tuple[int, int, int, list[str]]:
    rows, cols = stdscr.getmaxyx()
    available_rows = max(1, rows - bottom_margin)
    content_width = max(10, width - 4)
    text = wrap_lines(lines, content_width)
    height = len(text) + 4
    top = max(0, (available_rows - height) // 2)
    left = max(0, (cols - width) // 2)
    bottom = min(available_rows - 1, top + height - 1)
    right = min(cols - 1, left + width - 1)

    try:
        stdscr.attron(curses.color_pair(1))
        for y in range(top, bottom + 1):
            stdscr.addstr(y, left, " " * max(0, right - left + 1))
        stdscr.attroff(curses.color_pair(1))
        stdscr.hline(top, left, curses.ACS_HLINE, max(0, right - left + 1))
        stdscr.hline(bottom, left, curses.ACS_HLINE, max(0, right - left + 1))
        stdscr.vline(top, left, curses.ACS_VLINE, max(0, bottom - top + 1))
        stdscr.vline(top, right, curses.ACS_VLINE, max(0, bottom - top + 1))
        stdscr.addch(top, left, curses.ACS_ULCORNER)
        stdscr.addch(top, right, curses.ACS_URCORNER)
        stdscr.addch(bottom, left, curses.ACS_LLCORNER)
        stdscr.addch(bottom, right, curses.ACS_LRCORNER)
    except curses.error:
        pass

    for offset, line in enumerate(text):
        y = top + 2 + offset
        if y >= available_rows - 1:
            break
        clipped = line[:content_width]
        try:
            stdscr.addstr(y, left + 2, clipped, curses.color_pair(1))
        except curses.error:
            pass

    return top, left, content_width, text


def bottom_window(stdscr: curses.window, width: int, lines: Iterable[str]) -> None:
    rows, cols = stdscr.getmaxyx()
    width = min(width, cols)
    content_width = max(10, width - 4)
    text = wrap_lines(lines, content_width)
    height = len(text) + 4
    top = max(0, rows - height - 1)
    left = max(0, (cols - width) // 2)
    bottom = min(rows - 1, top + height - 1)
    right = min(cols - 1, left + width - 1)

    try:
        stdscr.attron(curses.color_pair(1))
        for y in range(top, bottom + 1):
            stdscr.addstr(y, left, " " * max(0, right - left + 1))
        stdscr.attroff(curses.color_pair(1))
        stdscr.hline(top, left, curses.ACS_HLINE, max(0, right - left + 1))
        stdscr.hline(bottom, left, curses.ACS_HLINE, max(0, right - left + 1))
        stdscr.vline(top, left, curses.ACS_VLINE, max(0, bottom - top + 1))
        stdscr.vline(top, right, curses.ACS_VLINE, max(0, bottom - top + 1))
        stdscr.addch(top, left, curses.ACS_ULCORNER)
        stdscr.addch(top, right, curses.ACS_URCORNER)
        stdscr.addch(bottom, left, curses.ACS_LLCORNER)
        stdscr.addch(bottom, right, curses.ACS_LRCORNER)
    except curses.error:
        pass

    for offset, line in enumerate(text):
        y = top + 2 + offset
        if y >= rows - 1:
            break
        try:
            stdscr.addstr(y, left + 2, line[:content_width], curses.color_pair(1))
        except curses.error:
            pass


def wrap_lines(lines: Iterable[str], width: int) -> list[str]:
    wrapped: list[str] = []
    for line in lines:
        if not line:
            wrapped.append("")
            continue

        indent = continuation_indent(line)
        chunks = textwrap.wrap(
            line,
            width=width,
            subsequent_indent=" " * indent,
            break_long_words=False,
            break_on_hyphens=False,
        )
        wrapped.extend(chunks or [""])
    return wrapped


def continuation_indent(line: str) -> int:
    match = re.match(r"^(\s*\d+\.\s+\*?\s*)", line)
    if match:
        return len(match.group(1))
    return len(line) - len(line.lstrip(" "))


def prompt_text(
    stdscr: curses.window,
    title: str,
    prompt: str,
    context_lines: Iterable[str] = (),
    max_length: int = 64,
) -> str | None:
    curses.echo()
    try:
        curses.curs_set(1)
    except curses.error:
        pass

    stdscr.erase()
    context = list(context_lines)
    top, left, _content_width, rendered_lines = centered_window(stdscr, 72, [title, "", *context, prompt])
    rows, cols = stdscr.getmaxyx()
    input_y = top + 2 + len(rendered_lines) - 1
    input_x = left + 2 + len(prompt) + 1
    max_input_length = max(1, min(max_length, cols - input_x - 2))
    try:
        stdscr.move(input_y, input_x)
        raw = stdscr.getstr(input_y, input_x, max_input_length)
    except curses.error:
        raw = b""
    finally:
        curses.noecho()
        try:
            curses.curs_set(0)
        except curses.error:
            pass

    value = raw.decode("utf-8", errors="ignore").strip()
    return value or None


def prompt_multiline_text(
    stdscr: curses.window,
    title: str,
    prompt: str,
    context_lines: Iterable[str] = (),
) -> str | None:
    text = ""
    context = [*context_lines, "Type freely. Ctrl-D saves. Ctrl-C cancels.", ""]

    try:
        curses.curs_set(1)
    except curses.error:
        pass

    while True:
        stdscr.erase()
        rows, cols = stdscr.getmaxyx()
        content_width = max(10, min(72, cols - 4) - 4)
        display_lines = [title, "", *context, f"{prompt}:", *text_area_lines(text, content_width)]
        top, left, _width, rendered_lines = centered_window(stdscr, 72, display_lines)
        cursor_y, cursor_x = text_cursor_position(top, left, rendered_lines, text, content_width)
        try:
            stdscr.move(cursor_y, cursor_x)
        except curses.error:
            pass
        stdscr.refresh()

        key = stdscr.getch()
        if key == ascii.EOT:
            try:
                curses.curs_set(0)
            except curses.error:
                pass
            return text.strip() or None
        if key == ascii.ETX:
            try:
                curses.curs_set(0)
            except curses.error:
                pass
            return None
        if key in (curses.KEY_BACKSPACE, 127, ascii.BS):
            text = text[:-1]
            continue
        if key in (curses.KEY_ENTER, 10, 13):
            text += "\n"
            continue
        if 0 <= key < 256 and chr(key).isprintable():
            text += chr(key)


def text_area_lines(value: str, width: int) -> list[str]:
    if not value:
        return [""]

    lines: list[str] = []
    for paragraph in value.split("\n"):
        if paragraph == "":
            lines.append("")
        else:
            lines.extend(wrap_editor_paragraph(paragraph, width))
    return lines


def wrap_editor_paragraph(paragraph: str, width: int) -> list[str]:
    remaining = paragraph
    lines: list[str] = []
    while remaining:
        if len(remaining) <= width:
            lines.append(remaining)
            break

        candidate = remaining[:width]
        break_at = candidate.rfind(" ")
        if break_at <= 0:
            break_at = width - 1

        split_at = break_at + 1
        lines.append(remaining[:split_at])
        remaining = remaining[split_at:]

    return lines or [""]


def text_cursor_position(top: int, left: int, rendered_lines: list[str], value: str, width: int) -> tuple[int, int]:
    area_lines = text_area_lines(value, width)
    y = top + 2 + len(rendered_lines) - 1
    x = left + 2 + len(area_lines[-1])
    return y, x


def prompt_name_description(
    stdscr: curses.window,
    title: str,
    current_name: str | None = None,
    current_description: str | None = None,
) -> tuple[str, str] | None:
    context = []
    label_width = len("Current description:")
    if current_name is not None:
        context.append(f"{'Current name:':<{label_width}} {current_name}")
    if current_description is not None:
        context.append(f"{'Current description:':<{label_width}} {current_description.replace(chr(10), ' / ')}")
    if context:
        context.append("")

    name = prompt_text(stdscr, title, "Name:", context)
    if name is None:
        return None
    description = prompt_multiline_text(stdscr, title, "Description", context)
    if description is None:
        return None
    return name, description


def prompt_menu(stdscr: curses.window, title: str, options: list[str]) -> int | None:
    while True:
        lines = [title, ""]
        for index, option in enumerate(options, start=1):
            lines.append(f"{index}. {option}")
        lines.extend(["", "B: back"])
        stdscr.erase()
        centered_window(stdscr, 72, lines)
        stdscr.refresh()
        key = stdscr.getch()
        if key in (ord("b"), ord("B")):
            return None
        index = key - ord("1")
        if 0 <= index < len(options):
            return index


def draw_system(stdscr: curses.window, world: StoryWorld, state: GameState, system: System) -> None:
    lines = [
        "Dark Qualms",
        "",
        f"System: {system.name}",
        f"Star: {system.star_type}",
        f"Sol offset: {format_signed_au(system.position_au[0])}, {format_signed_au(system.position_au[1])}",
    ]
    if system.description:
        lines.extend(["", system.description])
    lines.extend(["", "Destinations:"])
    last_orbital_id = state.last_orbital_by_system.get(system.id)
    for index, orbital in enumerate(system.orbitals, start=1):
        marker = "*" if orbital.id == last_orbital_id else " "
        lines.append(f"{index}. {marker} {orbital.name} [{orbital_type_label(system, orbital)}]")
    lines.extend(["", "Number: travel", "L: leave system    M: map    Q: quit"])
    centered_window(stdscr, 72, lines, bottom_margin=editor_box_margin(stdscr, state))


def draw_jump_list(stdscr: curses.window, world: StoryWorld, state: GameState, system: System) -> None:
    lines = [
        "Leave System",
        "",
        f"Current: {system.name}",
        f"Sol offset: {format_signed_au(system.position_au[0])}, {format_signed_au(system.position_au[1])}",
        "",
        "Jump points:",
    ]
    for index, hop in enumerate(sorted_hops(world, system), start=1):
        dx = hop.position_au[0]
        dy = hop.position_au[1]
        distance = system_distance_au(system, hop)
        lines.append(f"{index}. {hop.name} [{format_signed_au(dx)}, {format_signed_au(dy)}] {distance:.0f} AU")
    lines.extend(["", "Number: jump", "B: back    M: map    Q: quit"])
    centered_window(stdscr, 80, lines, bottom_margin=editor_box_margin(stdscr, state))


def draw_map(stdscr: curses.window, world: StoryWorld, state: GameState, system: System) -> None:
    lines = [
        "Local Map",
        "",
        *build_map_lines(world, system),
        "",
        "@ current    * system    lines: available jumps",
        "B: back",
        "Q: quit",
    ]
    centered_window(stdscr, 76, lines)


def draw_orbit(stdscr: curses.window, state: GameState, orbital: Orbital) -> None:
    lines = [
        destination_status(orbital),
        "",
        orbital.description,
        "",
        "L: land",
        "T: return to system",
        "Q: quit",
    ]
    centered_window(stdscr, 72, lines, bottom_margin=editor_box_margin(stdscr, state))


def draw_option(stdscr: curses.window, state: GameState, orbital: Orbital, option: LandingOption) -> None:
    lines = [
        f"{orbital.name}: {option.name}",
        "",
        option.description,
        "",
    ]
    choice_number = 1
    if option.details:
        lines.append("Details:")
        for detail in option.details:
            lines.append(f"{choice_number}. {detail.name} [{detail.kind}]")
            choice_number += 1
        lines.append("")

    if option.destinations:
        lines.append("Destinations:")
    for index, child in enumerate(option.destinations, start=1):
        lines.append(f"{choice_number}. {child.name} [{child.kind}]")
        choice_number += 1
    if state.destination_path == state.docked_path:
        lines.extend(["", "T: take off"])
    lines.append("")
    if state.destination_path != state.docked_path:
        lines.append("B: back")
    lines.extend([
        "Q: quit",
    ])
    centered_window(stdscr, 72, lines, bottom_margin=editor_box_margin(stdscr, state))


def editor_commands_for_state(state: GameState) -> list[str]:
    if not state.editor_enabled or state.detail_index is not None or state.view == "map":
        return []
    if state.view == "jump":
        return ["A: add system"]
    if state.destination_path:
        return ["A: add", "D: delete detail", "E: edit destination"]
    if state.orbital_id is None:
        return ["A: add orbital", "D: delete orbital", "E: edit system"]
    return ["E: edit orbital"]


def editor_box_lines(state: GameState) -> list[str]:
    if not state.editor_enabled:
        return []
    commands = editor_commands_for_state(state)
    if not commands and not state.message:
        return []

    lines = ["Editor"]
    if state.message:
        lines.extend(["", state.message])
    if commands:
        if state.message:
            lines.append("")
        lines.extend(commands)
    return lines


def editor_box_margin(stdscr: curses.window, state: GameState) -> int:
    lines = editor_box_lines(state)
    if not lines:
        return 0
    _rows, cols = stdscr.getmaxyx()
    width = min(72, cols)
    content_width = max(10, width - 4)
    return len(wrap_lines(lines, content_width)) + 5


def draw_editor_box(stdscr: curses.window, state: GameState) -> None:
    lines = editor_box_lines(state)
    if not lines:
        return
    bottom_window(stdscr, 72, lines)


def draw_detail(stdscr: curses.window, orbital: Orbital, destination: LandingOption, detail: Detail) -> None:
    lines = [
        f"{orbital.name}: {destination.name}",
        "",
        detail.name,
        "",
        detail.description,
        "",
        "B: back",
        "Q: quit",
    ]
    centered_window(stdscr, 72, lines)


def run_curses(stdscr: curses.window, world: StoryWorld, data_path: Path, editor_enabled: bool = False) -> None:
    curses.curs_set(0)
    curses.use_default_colors()
    curses.init_pair(1, curses.COLOR_WHITE, curses.COLOR_BLACK)
    stdscr.keypad(True)
    state = GameState(system_id=world.start_system, editor_enabled=editor_enabled)

    while True:
        stdscr.erase()
        system = world.system_by_id(state.system_id)

        if state.view == "jump":
            draw_jump_list(stdscr, world, state, system)
        elif state.view == "map":
            draw_map(stdscr, world, state, system)
        elif state.orbital_id is None:
            draw_system(stdscr, world, state, system)
        else:
            orbital = orbital_by_id(system, state.orbital_id)
            selected_destination = destination_at_path(orbital, state.destination_path)
            selected_detail = detail_at_state(selected_destination, state.detail_index)
            if selected_destination is not None and selected_detail is not None:
                draw_detail(stdscr, orbital, selected_destination, selected_detail)
            elif selected_destination is not None:
                draw_option(stdscr, state, orbital, selected_destination)
            else:
                draw_orbit(stdscr, state, orbital)

        draw_editor_box(stdscr, state)
        stdscr.refresh()
        key = stdscr.getch()
        if key in (ord("q"), ord("Q")):
            return
        if not state.editor_enabled or key not in (ord("a"), ord("A")):
            state.message = ""

        if state.view == "map":
            if key in (ord("b"), ord("B")):
                state.view = state.map_return_view
            continue

        if state.view == "jump":
            hops = sorted_hops(world, system)
            index = key - ord("1")
            if 0 <= index < len(hops):
                state.last_system_id = state.system_id
                state.system_id = hops[index].id
                state.view = "system"
                state.orbital_id = None
                state.docked_path.clear()
                state.destination_path.clear()
                state.detail_index = None
            elif key in (ord("b"), ord("B")):
                state.view = "system"
            elif key in (ord("m"), ord("M")):
                state.map_return_view = "jump"
                state.view = "map"
            elif state.editor_enabled and key in (ord("a"), ord("A")):
                added = prompt_add_system(stdscr, world, data_path, state.system_id)
                if added is not None:
                    world, state.message = added
            continue

        if state.destination_path:
            orbital = orbital_by_id(system, state.orbital_id)
            selected_destination = destination_at_path(orbital, state.destination_path)
            if selected_destination is None:
                state.destination_path.clear()
                state.detail_index = None
                continue
            if state.detail_index is not None:
                if key in (ord("b"), ord("B")):
                    state.detail_index = None
                continue
            index = key - ord("1")
            if 0 <= index < len(selected_destination.details):
                state.detail_index = index
            elif 0 <= index - len(selected_destination.details) < len(selected_destination.destinations):
                state.destination_path.append(index - len(selected_destination.details))
            elif key in (ord("t"), ord("T")) and state.destination_path == state.docked_path:
                state.last_orbital_by_system[state.system_id] = state.orbital_id
                state.docked_path.clear()
                state.destination_path.clear()
                state.detail_index = None
            elif key in (ord("b"), ord("B")):
                if state.destination_path != state.docked_path:
                    state.destination_path.pop()
            elif state.editor_enabled and key in (ord("a"), ord("A")):
                added = prompt_add_inside_destination(stdscr, world, data_path, state.system_id, state.orbital_id, state.destination_path)
                if added is not None:
                    world, state.message = added
            elif state.editor_enabled and key in (ord("d"), ord("D")):
                deleted = prompt_delete_detail(stdscr, world, data_path, state.system_id, state.orbital_id, state.destination_path, selected_destination)
                if deleted is not None:
                    world, state.message = deleted
            elif state.editor_enabled and key in (ord("e"), ord("E")):
                edited = prompt_edit_landing_destination(
                    stdscr,
                    world,
                    data_path,
                    state.system_id,
                    state.orbital_id,
                    state.destination_path,
                    selected_destination,
                )
                if edited is not None:
                    world, state.message = edited
            continue

        if state.orbital_id is None:
            index = key - ord("1")
            if 0 <= index < len(system.orbitals):
                state.orbital_id = system.orbitals[index].id
                state.docked_path.clear()
                state.destination_path.clear()
            elif state.editor_enabled and key in (ord("a"), ord("A")):
                added = prompt_add_orbital(stdscr, world, data_path, state.system_id)
                if added is not None:
                    world, state.message = added
            elif state.editor_enabled and key in (ord("d"), ord("D")):
                deleted = prompt_delete_orbital(stdscr, world, data_path, state.system_id)
                if deleted is not None:
                    world, state.message = deleted
                    state.last_orbital_by_system.pop(state.system_id, None)
            elif state.editor_enabled and key in (ord("e"), ord("E")):
                edited = prompt_edit_system(stdscr, world, data_path, state.system_id)
                if edited is not None:
                    world, state.message = edited
            elif key in (ord("l"), ord("L")):
                state.view = "jump"
            elif key in (ord("m"), ord("M")):
                state.map_return_view = "system"
                state.view = "map"
            continue

        if key in (ord("l"), ord("L")):
            orbital = orbital_by_id(system, state.orbital_id)
            if state.editor_enabled and not orbital.landing_options:
                added = prompt_add_landing_destination(stdscr, world, data_path, state.system_id, state.orbital_id, [])
                if added is not None:
                    world, state.message = added
                    orbital = orbital_by_id(world.system_by_id(state.system_id), state.orbital_id)
            if len(orbital.landing_options) == 1:
                state.docked_path = [0]
                state.destination_path = [0]
                state.detail_index = None
            elif len(orbital.landing_options) > 1:
                state.docked_path = [0]
                state.destination_path = [0]
                state.detail_index = None
        elif state.editor_enabled and key in (ord("e"), ord("E")):
            edited = prompt_edit_orbital(stdscr, world, data_path, state.system_id, state.orbital_id)
            if edited is not None:
                world, state.message = edited
        elif key in (ord("t"), ord("T"), 27):
            state.orbital_id = None
            state.docked_path.clear()
            state.destination_path.clear()
            state.detail_index = None


def destination_at_path(orbital: Orbital, destination_path: list[int]) -> LandingOption | None:
    if not destination_path:
        return None
    destinations = orbital.landing_options
    current: LandingOption | None = None
    for index in destination_path:
        if index < 0 or index >= len(destinations):
            return None
        current = destinations[index]
        destinations = current.destinations
    return current


def detail_at_state(destination: LandingOption | None, detail_index: int | None) -> Detail | None:
    if destination is None or detail_index is None:
        return None
    if detail_index < 0 or detail_index >= len(destination.details):
        return None
    return destination.details[detail_index]


def prompt_add_orbital(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
) -> tuple[StoryWorld, str] | None:
    type_choice = prompt_menu(stdscr, "Add Orbital", ["Planet", "Moon", "Station"])
    if type_choice is None:
        return None
    orbital_type = ["Planet", "Moon", "Station"][type_choice]
    parent = None
    if orbital_type == "Moon":
        system = world.system_by_id(system_id)
        parent_choices = [orbital for orbital in system.orbitals if orbital.type in {"Planet", "Moon"}]
        if not parent_choices:
            return world, "Add a planet before adding a moon"
        parent_choice = prompt_menu(stdscr, "Moon Parent", [orbital.name for orbital in parent_choices])
        if parent_choice is None:
            return None
        parent = parent_choices[parent_choice].id

    values = prompt_name_description(stdscr, "Add Orbital")
    if values is None:
        return None
    name, description = values
    try:
        return add_orbital(world, data_path, system_id, orbital_type, name, description, parent), f"Added orbital: {name}"
    except ValueError as error:
        return world, str(error)


def prompt_delete_orbital(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
) -> tuple[StoryWorld, str] | None:
    system = world.system_by_id(system_id)
    if not system.orbitals:
        return world, "No orbitals to delete"

    choice = prompt_menu(stdscr, "Delete Orbital", [f"{orbital.name} [{orbital_type_label(system, orbital)}]" for orbital in system.orbitals])
    if choice is None:
        return None

    orbital = system.orbitals[choice]
    try:
        return delete_orbital(world, data_path, system_id, orbital.id), f"Deleted orbital: {orbital.name}"
    except ValueError as error:
        return world, str(error)


def prompt_add_landing_destination(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
    orbital_id: str,
    parent_path: list[int],
) -> tuple[StoryWorld, str] | None:
    values = prompt_name_description(stdscr, "Add Destination")
    if values is None:
        return None
    name, description = values
    try:
        return add_landing_destination(world, data_path, system_id, orbital_id, parent_path, name, description), f"Added destination: {name}"
    except ValueError as error:
        return world, str(error)


def prompt_add_inside_destination(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
) -> tuple[StoryWorld, str] | None:
    choice = prompt_menu(stdscr, "Add", ["Add destination", "Add detail"])
    if choice == 0:
        return prompt_add_landing_destination(stdscr, world, data_path, system_id, orbital_id, destination_path)
    if choice == 1:
        return prompt_add_detail(stdscr, world, data_path, system_id, orbital_id, destination_path)
    return None


def prompt_add_detail(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
) -> tuple[StoryWorld, str] | None:
    values = prompt_name_description(stdscr, "Add Detail")
    if values is None:
        return None
    name, description = values
    try:
        return add_detail(world, data_path, system_id, orbital_id, destination_path, name, description), f"Added detail: {name}"
    except ValueError as error:
        return world, str(error)


def prompt_delete_detail(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    destination: LandingOption,
) -> tuple[StoryWorld, str] | None:
    if not destination.details:
        return world, "No details to delete"

    lines = ["Delete Detail", ""]
    for index, detail in enumerate(destination.details, start=1):
        lines.append(f"{index}. {detail.name} [{detail.kind}]")
    choice = prompt_text(stdscr, "Delete Detail", "Number:", lines)
    if choice is None:
        return None
    try:
        detail_index = int(choice) - 1
    except ValueError:
        return world, "Enter a detail number"

    try:
        name = destination.details[detail_index].name
        return delete_detail(world, data_path, system_id, orbital_id, destination_path, detail_index), f"Deleted detail: {name}"
    except (IndexError, ValueError) as error:
        return world, str(error)


def prompt_add_system(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    current_system_id: str,
) -> tuple[StoryWorld, str] | None:
    direction = prompt_text(stdscr, "Add System", "Direction (N, NE, E, SE, S, SW, W, NW):")
    if direction is None:
        return None
    values = prompt_name_description(stdscr, "Add System")
    if values is None:
        return None
    name, description = values
    try:
        return add_system(world, data_path, current_system_id, direction, name, description), f"Added system: {name}"
    except ValueError as error:
        return world, str(error)


def prompt_edit_system(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
) -> tuple[StoryWorld, str] | None:
    system = world.system_by_id(system_id)
    values = prompt_name_description(stdscr, "Edit System", system.name, system.description)
    if values is None:
        return None
    name, description = values
    try:
        return edit_system(world, data_path, system_id, name, description), f"Edited system: {name}"
    except ValueError as error:
        return world, str(error)


def prompt_edit_orbital(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
    orbital_id: str,
) -> tuple[StoryWorld, str] | None:
    orbital = orbital_by_id(world.system_by_id(system_id), orbital_id)
    values = prompt_name_description(stdscr, "Edit Orbital", orbital.name, orbital.description)
    if values is None:
        return None
    name, description = values
    try:
        return edit_orbital(world, data_path, system_id, orbital_id, name, description), f"Edited orbital: {name}"
    except ValueError as error:
        return world, str(error)


def prompt_edit_landing_destination(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    option: LandingOption,
) -> tuple[StoryWorld, str] | None:
    values = prompt_name_description(stdscr, "Edit Destination", option.name, option.description)
    if values is None:
        return None
    name, description = values
    try:
        return edit_landing_destination(world, data_path, system_id, orbital_id, destination_path, name, description), f"Edited destination: {name}"
    except ValueError as error:
        return world, str(error)


def build_map_lines(world: StoryWorld, current: System) -> list[str]:
    grid = [[" " for _ in range(MAP_WIDTH)] for _ in range(MAP_HEIGHT)]
    systems = list(world.systems)
    max_distance = max(system_distance_au(current, system) for system in systems) or 1.0
    scale = min((MAP_WIDTH - 8) / 2.0, (MAP_HEIGHT - 4) / 2.0) / max_distance

    positions: dict[str, tuple[int, int]] = {}
    center_x = MAP_WIDTH // 2
    center_y = MAP_HEIGHT // 2
    for system in systems:
        dx = system.position_au[0] - current.position_au[0]
        dy = system.position_au[1] - current.position_au[1]
        x = int(round(center_x + dx * scale))
        y = int(round(center_y - dy * scale))
        x = max(1, min(MAP_WIDTH - 2, x))
        y = max(1, min(MAP_HEIGHT - 2, y))
        positions[system.id] = (x, y)

    for hop_id in current.hops:
        draw_ascii_line(grid, positions[current.id], positions[hop_id])

    for system in systems:
        x, y = positions[system.id]
        grid[y][x] = "@" if system.id == current.id else "*"

    lines = ["".join(row).rstrip() for row in grid]
    labels = []
    for hop in sorted_hops(world, current):
        labels.append(f"{hop.name} {system_distance_au(current, hop):.0f} AU")
    if labels:
        lines.append("Hops: " + " | ".join(labels))
    return lines


def draw_ascii_line(grid: list[list[str]], start: tuple[int, int], end: tuple[int, int]) -> None:
    x0, y0 = start
    x1, y1 = end
    dx = abs(x1 - x0)
    dy = -abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    error = dx + dy
    x = x0
    y = y0

    while True:
        if (x, y) not in (start, end) and 0 <= y < len(grid) and 0 <= x < len(grid[y]):
            grid[y][x] = line_char(x0, y0, x1, y1)
        if x == x1 and y == y1:
            break
        error2 = 2 * error
        if error2 >= dy:
            error += dy
            x += sx
        if error2 <= dx:
            error += dx
            y += sy


def line_char(x0: int, y0: int, x1: int, y1: int) -> str:
    if x0 == x1:
        return "|"
    if y0 == y1:
        return "-"
    slope = (y1 - y0) / float(x1 - x0)
    return "\\" if slope > 0 else "/"


def dump_world(world: StoryWorld) -> str:
    lines: list[str] = []
    for system in world.systems:
        lines.append(f"{system.name} [{system.star_type}] @ {format_signed_au(system.position_au[0])}, {format_signed_au(system.position_au[1])}")
        if system.description:
            lines.append(system.description)
        if system.hops:
            lines.append("Hops: " + ", ".join(system.hops))
        for index, orbital in enumerate(system.orbitals, start=1):
            lines.append(f"{index}. {orbital.name} [{orbital_type_label(system, orbital)}] - {orbital.description}")
            for option_index, option in enumerate(orbital.landing_options, start=1):
                dump_destination(option, lines, f"   {option_index}.")
    return "\n".join(lines)


def dump_destination(option: LandingOption, lines: list[str], prefix: str) -> None:
    lines.append(f"{prefix} {option.name} [{option.kind}]: {option.description}")
    for index, detail in enumerate(option.details, start=1):
        lines.append(f"      {prefix}d{index}. {detail.name} [{detail.kind}]: {detail.description}")
    for index, child in enumerate(option.destinations, start=1):
        dump_destination(child, lines, f"   {prefix}{index}.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Dark Qualms story prototype")
    parser.add_argument("data_path", nargs="?", type=Path, help="Data directory or story_systems.json file")
    parser.add_argument("--data", type=Path, help="Data directory or story_systems.json file")
    parser.add_argument("--editor", action="store_true", help="Expose in-game story editing commands")
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--dump", action="store_true")
    args = parser.parse_args()

    data_file = resolve_data_file(args.data or args.data_path or DATA_PATH)
    world = load_world(data_file)
    if args.validate:
        print(f"story data ok: {data_file}")
        return 0
    if args.dump:
        print(dump_world(world))
        return 0

    curses.wrapper(run_curses, world, data_file, args.editor)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

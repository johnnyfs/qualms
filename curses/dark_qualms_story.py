#!/usr/bin/env python3
from __future__ import annotations

import argparse
import curses
import json
import re
import shutil
import sys
import textwrap
from curses import ascii
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from qualms import ActionAttempt, ActionResult, Entity, RulesEngine, TraitInstance, WorldState
from qualms.story_writer import write_story_world_yaml
from qualms.yaml_loader import load_game_definition

DATA_PATH = PROJECT_ROOT / "stories" / "stellar"
ORBITAL_TYPES = {"Planet", "Moon", "Station"}
OPTION_KINDS = {"Bar", "Tourist Destination", "Destination"}
CLI_TOGGLE_COAUTHOR = "__qualms_toggle_coauthor__"
MAX_GAMEPLAY_HISTORY = 50
OBJECT_INTERACTIONS = {"Examine", "Take", "Use", "Power up"}
NPC_INTERACTIONS = {"Examine", "Talk"}
SHIP_INTERACTIONS = {"Examine", "Board"}
DESTINATION_INTERACTIONS = {"Enter"}
MAX_HOP_DISTANCE_AU = 350000.0
MAP_WIDTH = 58
MAP_HEIGHT = 17
DEFAULT_HOP_DISTANCE_AU = 200000.0
SAVE_FORMAT_VERSION = 1
GENERIC_SAVE_FORMAT_VERSION = 1


@dataclass(frozen=True)
class BeforeRule:
    interaction: str
    message: str
    when: tuple[str, ...] = ()
    unless: tuple[str, ...] = ()
    on_complete: tuple[str, ...] = ()


@dataclass(frozen=True)
class Sequence:
    id: str
    when: tuple[str, ...]
    unless: tuple[str, ...]
    messages: tuple[str, ...]
    on_complete: tuple[str, ...]


@dataclass(frozen=True)
class UseRule:
    target: str
    messages: tuple[str, ...]
    on_complete: tuple[str, ...] = ()
    when: tuple[str, ...] = ()
    unless: tuple[str, ...] = ()


@dataclass(frozen=True)
class StoryObject:
    id: str
    name: str
    description: str
    interactions: tuple[str, ...]
    collectable: bool = False
    equipment_slot: str | None = None
    fuel_station: bool = False
    before: tuple[BeforeRule, ...] = ()
    use_rules: tuple[UseRule, ...] = ()
    visible_when: tuple[str, ...] = ()
    visible_unless: tuple[str, ...] = ()


@dataclass(frozen=True)
class NPC:
    id: str
    name: str
    description: str
    examine_description: str
    interactions: tuple[str, ...]
    before: tuple[BeforeRule, ...] = ()
    visible_when: tuple[str, ...] = ()
    visible_unless: tuple[str, ...] = ()


@dataclass(frozen=True)
class ConditionalText:
    text: str
    when: tuple[str, ...] = ()
    unless: tuple[str, ...] = ()


@dataclass(frozen=True)
class Ship:
    id: str
    name: str
    description: str
    unlock: bool = False
    controlled: bool = False
    equipment_slots: tuple[str, ...] = ()
    abilities: tuple[str, ...] = ()
    objects: tuple[StoryObject, ...] = ()
    before: tuple[BeforeRule, ...] = ()
    display_names: tuple[ConditionalText, ...] = ()
    interior_descriptions: tuple[ConditionalText, ...] = ()
    taglines: tuple[ConditionalText, ...] = ()
    visible_when: tuple[str, ...] = ()
    visible_unless: tuple[str, ...] = ()


@dataclass(frozen=True)
class InteractionChoice:
    kind: str
    target: StoryObject | NPC | Ship
    interaction: str


@dataclass(frozen=True)
class NamedTarget:
    kind: str
    name: str
    value: Any
    aliases: tuple[str, ...]


@dataclass(frozen=True)
class GenericCliEntityView:
    id: str
    name: str
    description: str
    traits: frozenset[str]


@dataclass(frozen=True)
class GenericCliActionView:
    command: str
    action_id: str
    args: dict[str, Any]
    target_id: str | None = None


@dataclass(frozen=True)
class GenericCliView:
    actor_id: str
    location: GenericCliEntityView
    go_targets: tuple[GenericCliEntityView, ...] = ()
    people: tuple[GenericCliEntityView, ...] = ()
    things: tuple[GenericCliEntityView, ...] = ()
    inventory: tuple[GenericCliEntityView, ...] = ()
    actions: tuple[GenericCliActionView, ...] = ()


@dataclass
class GenericCliState:
    definition: Any
    runtime_state: WorldState
    engine: RulesEngine
    actor_id: str
    message: str = ""
    pending_messages: tuple[str, ...] = ()
    pending_index: int = 0
    last_save_path: str | None = None
    last_cli_location_id: str | None = None
    force_cli_location: bool = True
    seen_cli_location_ids: set[str] = field(default_factory=set)


class GenericCliContractError(ValueError):
    pass


@dataclass(frozen=True)
class LandingOption:
    id: str
    kind: str
    name: str
    description: str
    objects: tuple[StoryObject, ...] = ()
    npcs: tuple[NPC, ...] = ()
    ships: tuple[Ship, ...] = ()
    before: tuple[BeforeRule, ...] = ()
    sequences: tuple[Sequence, ...] = ()
    destinations: tuple[LandingOption, ...] = ()
    paths: tuple[str, ...] = ()
    port: bool = False
    visible_when: tuple[str, ...] = ()
    visible_unless: tuple[str, ...] = ()


@dataclass(frozen=True)
class Orbital:
    id: str
    name: str
    type: str
    description: str
    landing_options: tuple[LandingOption, ...]
    parent: str | None = None
    default_landing_destination_ids: tuple[str, ...] = ()


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
    start_orbital_id: str | None = None
    start_destination_ids: tuple[str, ...] = ()
    rules_definition: Any | None = None

    def system_by_id(self, system_id: str) -> System:
        for system in self.systems:
            if system.id == system_id:
                return system
        raise KeyError(system_id)


@dataclass
class GameState:
    system_id: str
    editor_enabled: bool = False
    view: str = "main_menu"
    menu_return_view: str = "system"
    map_return_view: str = "system"
    inventory_return_view: str = "system"
    use_return_view: str = "inventory"
    orbital_id: str | None = None
    docked_path: list[int] = field(default_factory=list)
    destination_path: list[int] = field(default_factory=list)
    current_location_id: str | None = None
    interaction_index: int | None = None
    player_ship_id: str | None = None
    boarded_ship_id: str | None = None
    ships: dict[str, Ship] = field(default_factory=dict)
    inventory_index: int = 0
    inventory: dict[str, StoryObject] = field(default_factory=dict)
    use_source_item_id: str | None = None
    equipment: dict[str, str] = field(default_factory=dict)
    object_locations: dict[str, str] = field(default_factory=dict)
    ship_locations: dict[str, str] = field(default_factory=dict)
    ship_fuel: dict[str, int] = field(default_factory=dict)
    continue_message: str = ""
    continue_on_complete: tuple[str, ...] = ()
    sequence_messages: tuple[str, ...] = ()
    sequence_index: int = 0
    sequence_on_complete: tuple[str, ...] = ()
    facts: set[str] = field(default_factory=set)
    last_system_id: str | None = None
    last_orbital_by_system: dict[str, str] = field(default_factory=dict)
    message: str = ""
    editor_box_top: int | None = None
    rules_definition: Any | None = None
    rules_state: Any | None = None
    rules_engine: RulesEngine | None = None
    local_id_map: dict[str, str] = field(default_factory=dict)
    last_save_path: str | None = None
    last_cli_location_id: str | None = None
    force_cli_location: bool = True
    seen_cli_location_ids: set[str] = field(default_factory=set)
    coauthor_mode: bool = False
    coauthor_session: Any | None = None
    gameplay_history: list[str] = field(default_factory=list)


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
        return path / "story.qualms.yaml"
    if not path.exists() and path.suffix.lower() not in {".yaml", ".yml"}:
        return path / "story.qualms.yaml"
    return path


def write_blank_yaml_world(path: Path) -> None:
    world = load_world_from_raw(blank_world_raw())
    write_story_world_yaml(world, path)


def yaml_definition_to_raw(definition: Any) -> dict:
    specs = {spec.id: spec for spec in definition.initial_entities}
    id_to_local = {
        spec.id: spec.metadata.get("local_id", spec.id)
        for spec in definition.initial_entities
    }
    local_map = definition.metadata.get("local_id_map", {})
    for local_id, entity_id in local_map.items():
        id_to_local.setdefault(entity_id, local_id)

    at_locations: dict[str, str] = {}
    docked_locations: dict[str, str] = {}
    path_targets: dict[str, list[str]] = {}
    controlled_ships: set[str] = set()
    for assertion in definition.initial_assertions:
        relation = assertion.get("relation")
        args = [expression_ref(arg) for arg in assertion.get("args", [])]
        if relation == "At" and len(args) == 2 and args[0] and args[1]:
            at_locations[args[0]] = args[1]
        elif relation == "DockedAt" and len(args) == 2 and args[0] and args[1]:
            docked_locations[args[0]] = args[1]
        elif relation == "Path" and len(args) == 2 and args[0] and args[1]:
            path_targets.setdefault(args[0], []).append(args[1])
        elif relation == "ControlledBy" and len(args) == 2 and args[0]:
            controlled_ships.add(args[0])

    raw_systems = []
    for system_spec in entity_specs_by_kind(definition, {"System"}):
        system_id = id_to_local_id(system_spec.id, id_to_local)
        star_fields = spec_fields(system_spec, "StarSystem")
        raw_systems.append(
            {
                "id": system_id,
                "name": presentable_name(system_spec),
                "star_type": str(star_fields.get("star_type", "Unspecified")),
                "description": presentable_description(system_spec),
                "position_au": [float(star_fields.get("x", 0.0)), float(star_fields.get("y", 0.0))],
                "hops": [id_to_local_id(hop, id_to_local) for hop in star_fields.get("hops", [])],
                "orbitals": [
                    orbital_to_raw(
                        orbital_spec,
                        definition,
                        id_to_local,
                        at_locations,
                        docked_locations,
                        path_targets,
                        controlled_ships,
                    )
                    for orbital_spec in child_specs(definition, system_spec.id, at_locations, {"Planet", "Moon", "Station"})
                ],
            }
        )

    start = definition.metadata.get("start", {})
    start_system = id_to_local_id(str(start.get("system", raw_systems[0]["id"] if raw_systems else "empty-system")), id_to_local)
    raw = {
        "start_system": start_system,
        "systems": raw_systems,
    }
    start_location = start.get("location")
    if isinstance(start_location, str):
        destination_ids = destination_path_local_ids(start_location, at_locations, id_to_local, definition)
        if destination_ids:
            orbital_entity_id = destination_path_orbital(start_location, at_locations, definition)
            raw["start_location"] = {
                "system_id": start_system,
                "orbital_id": id_to_local_id(orbital_entity_id, id_to_local) if orbital_entity_id else None,
                "destination_ids": destination_ids,
            }
    return raw


def orbital_to_raw(
    spec: Any,
    definition: Any,
    id_to_local: dict[str, str],
    at_locations: dict[str, str],
    docked_locations: dict[str, str],
    path_targets: dict[str, list[str]],
    controlled_ships: set[str],
) -> dict:
    orbital_fields = spec_fields(spec, "OrbitalBody")
    orbital_type = str(orbital_fields.get("orbital_type", spec.kind or "Planet"))
    raw = {
        "id": id_to_local_id(spec.id, id_to_local),
        "name": presentable_name(spec),
        "type": orbital_type,
        "description": presentable_description(spec),
        "landing_options": [
            destination_to_raw(child, definition, id_to_local, at_locations, docked_locations, path_targets, controlled_ships)
            for child in child_specs(definition, spec.id, at_locations, {"Destination"})
        ],
    }
    parent = orbital_fields.get("parent")
    if parent:
        raw["parent"] = id_to_local_id(str(parent), id_to_local)
    default_landing_path = orbital_fields.get("default_landing_path", [])
    if default_landing_path:
        raw["default_landing_destination_ids"] = list(default_landing_path)
    return raw


def destination_to_raw(
    spec: Any,
    definition: Any,
    id_to_local: dict[str, str],
    at_locations: dict[str, str],
    docked_locations: dict[str, str],
    path_targets: dict[str, list[str]],
    controlled_ships: set[str],
) -> dict:
    metadata = dict(spec.metadata)
    before, sequences = destination_rules_to_local(spec, id_to_local, definition)
    paths = [id_to_local_id(target_id, id_to_local) for target_id in path_targets.get(spec.id, [])]
    return {
        "id": id_to_local_id(spec.id, id_to_local),
        "kind": metadata.get("display_kind", "Destination"),
        "name": presentable_name(spec),
        "description": presentable_description(spec),
        "objects": [
            object_to_raw(child, id_to_local, definition)
            for child in child_specs(definition, spec.id, at_locations, {"StoryObject"})
        ],
        "npcs": [
            npc_to_raw(child, id_to_local, definition)
            for child in child_specs(definition, spec.id, at_locations, {"NPC"})
        ],
        "ships": [
            ship_to_raw(ship, definition, id_to_local, at_locations, docked_locations, controlled_ships)
            for ship in docked_child_specs(definition, spec.id, docked_locations)
        ],
        "before": before_rules_to_raw(before),
        "sequences": [
            {
                "id": sequence.id,
                "when": list(sequence.when),
                "unless": list(sequence.unless),
                "messages": list(sequence.messages),
                "on_complete": list(sequence.on_complete),
            }
            for sequence in sequences
        ],
        "destinations": [
            destination_to_raw(child, definition, id_to_local, at_locations, docked_locations, path_targets, controlled_ships)
            for child in child_specs(definition, spec.id, at_locations, {"Destination"})
        ],
        **({"paths": paths} if paths else {}),
        **({"port": bool(metadata.get("port"))} if metadata.get("port") else {}),
        **({"visible_when": list(metadata.get("visible_when", []))} if metadata.get("visible_when") else {}),
        **({"visible_unless": list(metadata.get("visible_unless", []))} if metadata.get("visible_unless") else {}),
    }


def object_to_raw(spec: Any, id_to_local: dict[str, str], definition: Any) -> dict:
    metadata = dict(spec.metadata)
    before, use_rules = object_rules_to_local(spec, id_to_local, definition)
    equipment_fields = trait_attachment_fields(spec, "Equipment")
    fuel_station = bool(metadata.get("fuel_station", has_trait_attachment(spec, "FuelStation")))
    return {
        "id": id_to_local_id(spec.id, id_to_local),
        "name": presentable_name(spec),
        "description": presentable_description(spec),
        "interactions": list(metadata.get("interactions", default_object_interactions(spec))),
        "collectable": bool(metadata.get("collectable", has_trait_attachment(spec, "Portable"))),
        **({"equipment_slot": equipment_fields.get("slot")} if equipment_fields.get("slot") else {}),
        **({"fuel_station": True} if fuel_station else {}),
        "before": before_rules_to_raw(before),
        "use_rules": use_rules_to_raw(use_rules),
        **({"visible_when": list(metadata.get("visible_when", []))} if metadata.get("visible_when") else {}),
        **({"visible_unless": list(metadata.get("visible_unless", []))} if metadata.get("visible_unless") else {}),
    }


def npc_to_raw(spec: Any, id_to_local: dict[str, str], definition: Any) -> dict:
    metadata = dict(spec.metadata)
    before = before_rules_from_local_rules(spec, id_to_local, definition)
    presentable = spec_fields(spec, "Presentable")
    return {
        "id": id_to_local_id(spec.id, id_to_local),
        "name": presentable_name(spec),
        "description": presentable_description(spec),
        "examine_description": str(presentable.get("examine_description") or presentable_description(spec)),
        "interactions": list(metadata.get("interactions", ("Examine", "Talk"))),
        "before": before_rules_to_raw(before),
        **({"visible_when": list(metadata.get("visible_when", []))} if metadata.get("visible_when") else {}),
        **({"visible_unless": list(metadata.get("visible_unless", []))} if metadata.get("visible_unless") else {}),
    }


def ship_to_raw(
    spec: Any,
    definition: Any,
    id_to_local: dict[str, str],
    at_locations: dict[str, str],
    docked_locations: dict[str, str],
    controlled_ships: set[str],
) -> dict:
    metadata = dict(spec.metadata)
    vehicle_fields = spec_fields(spec, "Vehicle")
    return {
        "id": id_to_local_id(spec.id, id_to_local),
        "name": presentable_name(spec),
        "description": presentable_description(spec),
        "unlock": bool(metadata.get("unlock", False)),
        "controlled": spec.id in controlled_ships or bool(metadata.get("controlled", False)),
        "equipment_slots": list(metadata.get("equipment_slots", [])),
        "abilities": list(vehicle_fields.get("abilities", metadata.get("abilities", []))),
        "objects": [
            object_to_raw(child, id_to_local, definition)
            for child in child_specs(definition, spec.id, at_locations, {"StoryObject"})
        ],
        "before": before_rules_to_raw(before_rules_from_local_rules(spec, id_to_local, definition)),
        "display_names": list(metadata.get("display_names", [])),
        "interior_descriptions": list(metadata.get("interior_descriptions", [])),
        "taglines": list(metadata.get("taglines", [])),
        **({"visible_when": list(metadata.get("visible_when", []))} if metadata.get("visible_when") else {}),
        **({"visible_unless": list(metadata.get("visible_unless", []))} if metadata.get("visible_unless") else {}),
    }


def load_world_from_raw(raw: dict, rules_definition: Any | None = None) -> StoryWorld:
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
                    default_landing_destination_ids=load_fact_conditions(
                        orbital_raw.get("default_landing_destination_ids", []),
                        f"{orbital_context}.default_landing_destination_ids",
                    ),
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

    start_orbital_id, start_destination_ids = load_start_location(raw, start_system)
    world = StoryWorld(
        start_system=start_system,
        systems=tuple(systems),
        start_orbital_id=start_orbital_id,
        start_destination_ids=start_destination_ids,
        rules_definition=rules_definition,
    )
    validate_world(world)
    return world


def validate_world(world: StoryWorld) -> None:
    world.system_by_id(world.start_system)
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
            if orbital.default_landing_destination_ids:
                try:
                    destination_path_by_ids(orbital, orbital.default_landing_destination_ids)
                except KeyError as error:
                    raise ValueError(f"{system.id}.{orbital.id}.default_landing_destination_ids references unknown destination {error.args[0]}") from error

        for hop_id in system.hops:
            if hop_id not in system_ids:
                raise ValueError(f"{system.id}.hops references unknown system {hop_id}")

            hop_system = world.system_by_id(hop_id)
            if system.id not in hop_system.hops:
                raise ValueError(f"{system.id}.hops to {hop_id} must be reciprocal")

            if system_distance_au(system, hop_system) > MAX_HOP_DISTANCE_AU:
                raise ValueError(f"{system.id}.hops to {hop_id} exceeds {MAX_HOP_DISTANCE_AU:.0f} AU")
    validate_start_location(world)


def entity_specs_by_kind(definition: Any, kinds: set[str]) -> list[Any]:
    return [spec for spec in definition.initial_entities if spec.kind in kinds]


def child_specs(definition: Any, parent_id: str, locations: dict[str, str], kinds: set[str]) -> list[Any]:
    return [
        spec
        for spec in definition.initial_entities
        if spec.kind in kinds and locations.get(spec.id) == parent_id
    ]


def docked_child_specs(definition: Any, parent_id: str, locations: dict[str, str]) -> list[Any]:
    return [
        spec
        for spec in definition.initial_entities
        if spec.kind == "Ship" and locations.get(spec.id) == parent_id
    ]


def expression_ref(expression: Any) -> str | None:
    if isinstance(expression, dict) and set(expression) == {"ref"}:
        return str(expression["ref"])
    if isinstance(expression, str):
        return expression
    return None


def spec_fields(spec: Any, trait_id: str) -> dict[str, Any]:
    return dict(spec.fields.get(trait_id, {}))


def presentable_name(spec: Any) -> str:
    return str(spec_fields(spec, "Presentable").get("name", spec.metadata.get("local_id", spec.id)))


def presentable_description(spec: Any) -> str:
    return str(spec_fields(spec, "Presentable").get("description", ""))


def has_trait_attachment(spec: Any, trait_id: str) -> bool:
    return any(attachment.id == trait_id for attachment in spec.traits)


def trait_attachment_fields(spec: Any, trait_id: str) -> dict[str, Any]:
    fields = dict(spec.fields.get(trait_id, {}))
    for attachment in spec.traits:
        if attachment.id == trait_id:
            fields = {**attachment.fields, **fields}
    return fields


def default_object_interactions(spec: Any) -> list[str]:
    interactions = ["Examine"]
    if has_trait_attachment(spec, "Portable"):
        interactions.append("Take")
    if has_trait_attachment(spec, "Usable"):
        interactions.append("Use")
    return interactions


def id_to_local_id(entity_id: str | None, id_to_local: dict[str, str]) -> str:
    if entity_id is None:
        return ""
    return id_to_local.get(entity_id, entity_id)


def destination_path_local_ids(location_id: str, locations: dict[str, str], id_to_local: dict[str, str], definition: Any) -> list[str]:
    path: list[str] = []
    spec_by_id = {spec.id: spec for spec in definition.initial_entities}
    current: str | None = location_id
    while current:
        parent = locations.get(current)
        if parent is None:
            break
        spec = spec_by_id.get(current)
        if spec is not None and spec.kind == "Destination":
            path.append(id_to_local_id(current, id_to_local))
        if parent not in locations:
            break
        current = parent
    path.reverse()
    return path


def destination_path_orbital(location_id: str, locations: dict[str, str], definition: Any) -> str | None:
    current = location_id
    spec_by_id = {spec.id: spec for spec in definition.initial_entities}
    while current in locations:
        parent = locations[current]
        parent_spec = spec_by_id.get(parent)
        if parent_spec is not None and parent_spec.kind in {"Planet", "Moon", "Station"}:
            return parent
        current = parent
    return None


def before_rules_from_local_rules(spec: Any, id_to_local: dict[str, str], definition: Any) -> tuple[BeforeRule, ...]:
    rules: list[BeforeRule] = []
    for rule in spec.rules:
        if rule.phase != "before":
            continue
        message = first_emit_text(rule.effects)
        if not message:
            continue
        interaction = interaction_for_action(rule.pattern.action)
        if interaction is None:
            continue
        when, unless = predicate_to_fact_conditions(rule.guard, id_to_local, definition)
        rules.append(
            BeforeRule(
                interaction=interaction,
                message=message,
                when=tuple(when),
                unless=tuple(unless),
                on_complete=tuple(outcomes_from_effects(rule.effects, id_to_local)),
            )
        )
    return tuple(rules)


def object_rules_to_local(spec: Any, id_to_local: dict[str, str], definition: Any) -> tuple[tuple[BeforeRule, ...], tuple[UseRule, ...]]:
    before = before_rules_from_local_rules(spec, id_to_local, definition)
    use_rules: list[UseRule] = []
    for rule in spec.rules:
        if rule.pattern.action != "Use" or rule.phase not in {"instead", "after"}:
            continue
        target_pattern = rule.pattern.args.get("target")
        target_entity_id = expression_ref(target_pattern) if isinstance(target_pattern, dict) else None
        if target_entity_id is None:
            continue
        messages = tuple(emit_texts(rule.effects))
        if not messages:
            continue
        when, unless = predicate_to_fact_conditions(rule.guard, id_to_local, definition)
        use_rules.append(
            UseRule(
                target=id_to_local_id(target_entity_id, id_to_local),
                messages=messages,
                on_complete=tuple(outcomes_from_effects(rule.effects, id_to_local)),
                when=tuple(when),
                unless=tuple(unless),
            )
        )
    return before, tuple(use_rules)


def destination_rules_to_local(spec: Any, id_to_local: dict[str, str], definition: Any) -> tuple[tuple[BeforeRule, ...], tuple[Sequence, ...]]:
    before = before_rules_from_local_rules(spec, id_to_local, definition)
    sequences: list[Sequence] = []
    for rule in spec.rules:
        if rule.phase != "after" or rule.pattern.action != "Enter" or not rule.id.startswith("sequence:"):
            continue
        messages = tuple(emit_texts(rule.effects))
        if not messages:
            continue
        when, unless = predicate_to_fact_conditions(rule.guard, id_to_local, definition)
        sequence_id = rule.id.removeprefix("sequence:")
        sequences.append(
            Sequence(
                id=sequence_id,
                when=tuple(when),
                unless=tuple(unless),
                messages=messages,
                on_complete=tuple(outcomes_from_effects(rule.effects, id_to_local)),
            )
        )
    return before, tuple(sequences)


def interaction_for_action(action_id: str) -> str | None:
    return {
        "Enter": "Enter",
        "Examine": "Examine",
        "Take": "Take",
        "Use": "Use",
        "PowerUp": "Power up",
        "Talk": "Talk",
        "Board": "Board",
    }.get(action_id)


def first_emit_text(effects: tuple[dict[str, Any], ...]) -> str:
    for text in emit_texts(effects):
        return text
    return ""


def emit_texts(effects: tuple[dict[str, Any], ...]) -> list[str]:
    texts: list[str] = []
    for effect in effects:
        emit = effect.get("emit") if isinstance(effect, dict) else None
        if isinstance(emit, dict) and isinstance(emit.get("text"), str):
            texts.append(emit["text"])
    return texts


def outcomes_from_effects(effects: tuple[dict[str, Any], ...], id_to_local: dict[str, str]) -> list[str]:
    outcomes: list[str] = []
    controlled_ship_ids: set[str] = set()
    for effect in effects:
        assertion = effect.get("assert") if isinstance(effect, dict) else None
        if isinstance(assertion, dict) and assertion.get("relation") == "SequenceComplete":
            args = assertion.get("args", [])
            sequence_id = expression_literal(args[0]) if args else None
            if sequence_id is not None:
                outcomes.append(f"sequence:{sequence_id}:complete")
                continue
        if isinstance(assertion, dict) and assertion.get("relation") == "Visited":
            args = assertion.get("args", [])
            location_id = expression_ref(args[1]) if len(args) > 1 else None
            if location_id:
                outcomes.append(f"visited:destination:{id_to_local_id(location_id, id_to_local)}")
                continue
        if isinstance(assertion, dict) and assertion.get("relation") == "ControlledBy":
            args = assertion.get("args", [])
            ship_id = expression_ref(args[0]) if args else None
            if ship_id:
                controlled_ship_ids.add(id_to_local_id(ship_id, id_to_local))
    for effect in effects:
        fact = effect.get("set_fact") if isinstance(effect, dict) else None
        if not isinstance(fact, dict):
            continue
        fact_id = fact.get("id")
        if not isinstance(fact_id, str):
            continue
        if any(fact_id == f"ship:{ship_id}:owned" for ship_id in controlled_ship_ids):
            continue
        if fact_id not in outcomes:
            outcomes.append(fact_id)
    return outcomes


def predicate_to_fact_conditions(predicate: Any, id_to_local: dict[str, str], definition: Any) -> tuple[list[str], list[str]]:
    when: list[str] = []
    unless: list[str] = []
    collect_predicate_conditions(predicate, id_to_local, definition, when, unless, negated=False)
    return when, unless


def collect_predicate_conditions(
    predicate: Any,
    id_to_local: dict[str, str],
    definition: Any,
    when: list[str],
    unless: list[str],
    negated: bool,
) -> None:
    if predicate is True or predicate is None:
        return
    if isinstance(predicate, dict) and len(predicate) == 1:
        op, operand = next(iter(predicate.items()))
        if op == "all":
            for item in operand:
                collect_predicate_conditions(item, id_to_local, definition, when, unless, negated)
            return
        if op == "not":
            collect_predicate_conditions(operand, id_to_local, definition, when, unless, not negated)
            return
    fact = fact_string_from_predicate(predicate, id_to_local, definition)
    if fact:
        target = unless if negated else when
        if fact not in target:
            target.append(fact)


def fact_string_from_predicate(predicate: Any, id_to_local: dict[str, str], definition: Any) -> str | None:
    if not isinstance(predicate, dict) or len(predicate) != 1:
        return None
    op, operand = next(iter(predicate.items()))
    if op == "fact" and isinstance(operand, dict):
        fact_id = operand.get("id")
        args = operand.get("args", [])
        if fact_id == "Aboard" and len(args) == 2:
            ship_entity_id = expression_ref(args[1])
            if ship_entity_id:
                return f"ship:{id_to_local_id(ship_entity_id, id_to_local)}:boarded"
        return fact_id if isinstance(fact_id, str) else None
    if op == "relation" and isinstance(operand, dict):
        relation_id = operand.get("id")
        args = operand.get("args", [])
        if relation_id == "At" and len(args) == 2:
            subject_id = expression_ref(args[0])
            location_id = expression_ref(args[1])
            if subject_id and location_id:
                return f"ship:{id_to_local_id(subject_id, id_to_local)}:at:{id_to_local_id(location_id, id_to_local)}"
        if relation_id == "ControlledBy" and len(args) == 2:
            ship_entity_id = expression_ref(args[0])
            if ship_entity_id:
                return f"ship:{id_to_local_id(ship_entity_id, id_to_local)}:owned"
        if relation_id == "Visited" and len(args) == 2:
            location_id = expression_ref(args[1])
            if location_id:
                return f"visited:destination:{id_to_local_id(location_id, id_to_local)}"
        if relation_id == "SequenceComplete" and len(args) == 1:
            sequence_id = expression_literal(args[0])
            if sequence_id is not None:
                return f"sequence:{sequence_id}:complete"
    return None


def expression_literal(expression: Any) -> Any:
    if isinstance(expression, dict) and set(expression) == {"literal"}:
        return expression["literal"]
    if isinstance(expression, (str, int, float, bool)) or expression is None:
        return expression
    return None


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
        object_raws = option_raw.get("objects", option_raw.get("details", []))
        if not isinstance(object_raws, list):
            raise ValueError(f"{option_context}.objects must be a list")
        npc_raws = option_raw.get("npcs", [])
        if not isinstance(npc_raws, list):
            raise ValueError(f"{option_context}.npcs must be a list")
        ship_raws = option_raw.get("ships", [])
        if not isinstance(ship_raws, list):
            raise ValueError(f"{option_context}.ships must be a list")
        sequence_raws = option_raw.get("sequences", [])
        if not isinstance(sequence_raws, list):
            raise ValueError(f"{option_context}.sequences must be a list")

        objects = load_objects(object_raws, f"{option_context}.objects")
        npcs = load_npcs(npc_raws, f"{option_context}.npcs")
        ships = load_ships(ship_raws, f"{option_context}.ships")
        before = load_before_rules(option_raw.get("before", []), f"{option_context}.before", DESTINATION_INTERACTIONS)
        sequences = load_sequences(sequence_raws, f"{option_context}.sequences")
        destinations = load_landing_options(child_raws, f"{option_context}.destinations")
        if interaction_count(objects, npcs, ships) + len(destinations) > 9:
            raise ValueError(f"{option_context} must contain no more than 9 numbered choices")

        options.append(
            LandingOption(
                id=optional_id(option_raw, "destination"),
                kind=kind,
                name=require_string(option_raw, "name", option_context),
                description=require_string(option_raw, "description", option_context),
                objects=objects,
                npcs=npcs,
                ships=ships,
                before=before,
                sequences=sequences,
                destinations=destinations,
                paths=load_string_list(option_raw.get("paths", []), f"{option_context}.paths"),
                port=bool(option_raw.get("port", False)),
                visible_when=load_fact_conditions(option_raw.get("visible_when", []), f"{option_context}.visible_when"),
                visible_unless=load_fact_conditions(option_raw.get("visible_unless", []), f"{option_context}.visible_unless"),
            )
        )
    return tuple(options)


def load_objects(raw_objects: list, context: str) -> tuple[StoryObject, ...]:
    if len(raw_objects) > 9:
        raise ValueError(f"{context} must contain no more than 9 objects")

    objects: list[StoryObject] = []
    for object_index, object_raw in enumerate(raw_objects):
        object_context = f"{context}[{object_index}]"
        if not isinstance(object_raw, dict):
            raise ValueError(f"{object_context} must be an object")
        interactions = load_object_interactions(object_raw, object_context)
        objects.append(
            StoryObject(
                id=optional_id(object_raw, "object"),
                name=require_string(object_raw, "name", object_context),
                description=require_string(object_raw, "description", object_context),
                interactions=interactions,
                collectable=object_collectable(object_raw, interactions),
                equipment_slot=optional_string(object_raw, "equipment_slot", object_context),
                fuel_station=bool(object_raw.get("fuel_station", False)),
                before=load_before_rules(object_raw.get("before", []), f"{object_context}.before", OBJECT_INTERACTIONS),
                use_rules=load_use_rules(object_raw.get("use_rules", []), f"{object_context}.use_rules"),
                visible_when=load_fact_conditions(object_raw.get("visible_when", []), f"{object_context}.visible_when"),
                visible_unless=load_fact_conditions(object_raw.get("visible_unless", []), f"{object_context}.visible_unless"),
            )
        )
    return tuple(objects)


def load_npcs(raw_npcs: list, context: str) -> tuple[NPC, ...]:
    if len(raw_npcs) > 9:
        raise ValueError(f"{context} must contain no more than 9 NPCs")

    npcs: list[NPC] = []
    for npc_index, npc_raw in enumerate(raw_npcs):
        npc_context = f"{context}[{npc_index}]"
        if not isinstance(npc_raw, dict):
            raise ValueError(f"{npc_context} must be an object")
        interactions = load_interactions(npc_raw, npc_context, NPC_INTERACTIONS, ("Examine", "Talk"))
        npcs.append(
            NPC(
                id=optional_id(npc_raw, "npc"),
                name=require_string(npc_raw, "name", npc_context),
                description=require_string(npc_raw, "description", npc_context),
                examine_description=str(npc_raw.get("examine_description", require_string(npc_raw, "description", npc_context))),
                interactions=interactions,
                before=load_before_rules(npc_raw.get("before", []), f"{npc_context}.before", NPC_INTERACTIONS),
                visible_when=load_fact_conditions(npc_raw.get("visible_when", []), f"{npc_context}.visible_when"),
                visible_unless=load_fact_conditions(npc_raw.get("visible_unless", []), f"{npc_context}.visible_unless"),
            )
        )
    return tuple(npcs)


def load_ships(raw_ships: list, context: str) -> tuple[Ship, ...]:
    if len(raw_ships) > 9:
        raise ValueError(f"{context} must contain no more than 9 ships")

    ships: list[Ship] = []
    for ship_index, ship_raw in enumerate(raw_ships):
        ship_context = f"{context}[{ship_index}]"
        if not isinstance(ship_raw, dict):
            raise ValueError(f"{ship_context} must be an object")
        ships.append(
            Ship(
                id=optional_id(ship_raw, "ship"),
                name=require_string(ship_raw, "name", ship_context),
                description=require_string(ship_raw, "description", ship_context),
                unlock=bool(ship_raw.get("unlock", False)),
                controlled=bool(ship_raw.get("controlled", False)),
                equipment_slots=load_string_list(ship_raw.get("equipment_slots", []), f"{ship_context}.equipment_slots"),
                abilities=load_string_list(ship_raw.get("abilities", []), f"{ship_context}.abilities"),
                objects=load_objects(ship_raw.get("objects", []), f"{ship_context}.objects"),
                before=load_before_rules(ship_raw.get("before", []), f"{ship_context}.before", SHIP_INTERACTIONS),
                display_names=load_conditional_texts(ship_raw.get("display_names", []), f"{ship_context}.display_names"),
                interior_descriptions=load_conditional_texts(ship_raw.get("interior_descriptions", []), f"{ship_context}.interior_descriptions"),
                taglines=load_conditional_texts(ship_raw.get("taglines", []), f"{ship_context}.taglines"),
                visible_when=load_fact_conditions(ship_raw.get("visible_when", []), f"{ship_context}.visible_when"),
                visible_unless=load_fact_conditions(ship_raw.get("visible_unless", []), f"{ship_context}.visible_unless"),
            )
        )
    return tuple(ships)


def load_object_interactions(object_raw: dict, context: str) -> tuple[str, ...]:
    if "interactions" not in object_raw and "kind" in object_raw:
        kind = require_string(object_raw, "kind", context)
        if kind not in OBJECT_INTERACTIONS:
            raise ValueError(f"{context}.kind must be one of {sorted(OBJECT_INTERACTIONS)}")
        return (kind,)

    return load_interactions(object_raw, context, OBJECT_INTERACTIONS, ())


def object_collectable(object_raw: dict, interactions: tuple[str, ...]) -> bool:
    collectable = object_raw.get("collectable")
    if isinstance(collectable, bool):
        return collectable
    return "Take" in interactions


def optional_string(data: dict, field: str, context: str) -> str | None:
    value = data.get(field)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context}.{field} must be a non-empty string when present")
    return value


def load_interactions(
    raw: dict,
    context: str,
    allowed_interactions: set[str],
    default_interactions: tuple[str, ...],
) -> tuple[str, ...]:
    if "interactions" not in raw and default_interactions:
        return default_interactions

    raw_interactions = require_list(raw, "interactions", context)
    if not raw_interactions:
        raise ValueError(f"{context}.interactions must not be empty")

    interactions: list[str] = []
    for index, interaction in enumerate(raw_interactions):
        value = require_string({"interaction": interaction}, "interaction", f"{context}.interactions[{index}]")
        if value not in allowed_interactions:
            raise ValueError(f"{context}.interactions[{index}] must be one of {sorted(allowed_interactions)}")
        if value not in interactions:
            interactions.append(value)
    return tuple(interactions)


def load_before_rules(raw_rules: list, context: str, allowed_interactions: set[str]) -> tuple[BeforeRule, ...]:
    if not isinstance(raw_rules, list):
        raise ValueError(f"{context} must be a list")

    rules: list[BeforeRule] = []
    for rule_index, rule_raw in enumerate(raw_rules):
        rule_context = f"{context}[{rule_index}]"
        if not isinstance(rule_raw, dict):
            raise ValueError(f"{rule_context} must be an object")
        interaction = require_string(rule_raw, "interaction", rule_context)
        if interaction not in allowed_interactions:
            raise ValueError(f"{rule_context}.interaction must be one of {sorted(allowed_interactions)}")
        rules.append(
            BeforeRule(
                interaction=interaction,
                message=require_string(rule_raw, "message", rule_context),
                when=load_fact_conditions(rule_raw.get("when", []), f"{rule_context}.when"),
                unless=load_fact_conditions(rule_raw.get("unless", []), f"{rule_context}.unless"),
                on_complete=load_fact_conditions(rule_raw.get("on_complete", []), f"{rule_context}.on_complete"),
            )
        )
    return tuple(rules)


def load_use_rules(raw_rules: object, context: str) -> tuple[UseRule, ...]:
    if not isinstance(raw_rules, list):
        raise ValueError(f"{context} must be a list")
    rules: list[UseRule] = []
    for rule_index, rule_raw in enumerate(raw_rules):
        rule_context = f"{context}[{rule_index}]"
        if not isinstance(rule_raw, dict):
            raise ValueError(f"{rule_context} must be an object")
        messages = load_fact_conditions(rule_raw.get("messages", []), f"{rule_context}.messages")
        message = rule_raw.get("message")
        if isinstance(message, str) and message.strip():
            messages = (message, *messages)
        if not messages:
            raise ValueError(f"{rule_context}.messages must not be empty")
        rules.append(
            UseRule(
                target=require_string(rule_raw, "target", rule_context),
                messages=messages,
                on_complete=load_fact_conditions(rule_raw.get("on_complete", []), f"{rule_context}.on_complete"),
                when=load_fact_conditions(rule_raw.get("when", []), f"{rule_context}.when"),
                unless=load_fact_conditions(rule_raw.get("unless", []), f"{rule_context}.unless"),
            )
        )
    return tuple(rules)


def load_sequences(raw_sequences: list, context: str) -> tuple[Sequence, ...]:
    sequences: list[Sequence] = []
    for sequence_index, sequence_raw in enumerate(raw_sequences):
        sequence_context = f"{context}[{sequence_index}]"
        if not isinstance(sequence_raw, dict):
            raise ValueError(f"{sequence_context} must be an object")
        sequence_id = require_string(sequence_raw, "id", sequence_context)
        messages = load_fact_conditions(sequence_raw.get("messages", []), f"{sequence_context}.messages")
        if not messages:
            raise ValueError(f"{sequence_context}.messages must not be empty")
        sequences.append(
            Sequence(
                id=sequence_id,
                when=load_fact_conditions(sequence_raw.get("when", []), f"{sequence_context}.when"),
                unless=load_fact_conditions(sequence_raw.get("unless", [f"sequence:{sequence_id}:complete"]), f"{sequence_context}.unless"),
                messages=messages,
                on_complete=load_fact_conditions(sequence_raw.get("on_complete", [f"sequence:{sequence_id}:complete"]), f"{sequence_context}.on_complete"),
            )
        )
    return tuple(sequences)


def load_conditional_texts(raw_texts: object, context: str) -> tuple[ConditionalText, ...]:
    if not isinstance(raw_texts, list):
        raise ValueError(f"{context} must be a list")
    texts: list[ConditionalText] = []
    for text_index, text_raw in enumerate(raw_texts):
        text_context = f"{context}[{text_index}]"
        if isinstance(text_raw, str):
            texts.append(ConditionalText(text=text_raw))
            continue
        if not isinstance(text_raw, dict):
            raise ValueError(f"{text_context} must be a string or object")
        texts.append(
            ConditionalText(
                text=require_string(text_raw, "text", text_context),
                when=load_fact_conditions(text_raw.get("when", []), f"{text_context}.when"),
                unless=load_fact_conditions(text_raw.get("unless", []), f"{text_context}.unless"),
            )
        )
    return tuple(texts)


def load_string_list(raw_values: object, context: str) -> tuple[str, ...]:
    if not isinstance(raw_values, list):
        raise ValueError(f"{context} must be a list")
    values: list[str] = []
    for value_index, raw_value in enumerate(raw_values):
        value = require_string({"value": raw_value}, "value", f"{context}[{value_index}]")
        if value not in values:
            values.append(value)
    return tuple(values)


def load_fact_conditions(raw_facts: object, context: str) -> tuple[str, ...]:
    if not isinstance(raw_facts, list):
        raise ValueError(f"{context} must be a list")
    facts: list[str] = []
    for fact_index, fact in enumerate(raw_facts):
        value = require_string({"fact": fact}, "fact", f"{context}[{fact_index}]")
        if value not in facts:
            facts.append(value)
    return tuple(facts)


def optional_id(raw: dict, fallback: str) -> str:
    raw_id = raw.get("id")
    if isinstance(raw_id, str) and raw_id.strip():
        return raw_id
    raw_name = raw.get("name")
    if isinstance(raw_name, str):
        return slugify(raw_name, fallback)
    return fallback


def interaction_count(objects: tuple[StoryObject, ...], npcs: tuple[NPC, ...], ships: tuple[Ship, ...]) -> int:
    return (
        sum(len(story_object.interactions) for story_object in objects)
        + sum(len(npc.interactions) for npc in npcs)
        + sum(len(ship_interactions(ship)) for ship in ships)
    )


def load_start_location(raw: dict, start_system: str) -> tuple[str | None, tuple[str, ...]]:
    raw_location = raw.get("start_location", {})
    if raw_location == {}:
        return None, ()
    if not isinstance(raw_location, dict):
        raise ValueError("root.start_location must be an object")

    system_id = raw_location.get("system_id", start_system)
    if system_id != start_system:
        raise ValueError("root.start_location.system_id must match root.start_system")

    orbital_id = raw_location.get("orbital_id")
    if orbital_id is not None and (not isinstance(orbital_id, str) or not orbital_id.strip()):
        raise ValueError("root.start_location.orbital_id must be a non-empty string when present")

    destination_ids = raw_location.get("destination_ids", [])
    if not isinstance(destination_ids, list):
        raise ValueError("root.start_location.destination_ids must be a list")

    return orbital_id, tuple(
        require_string({"destination_id": destination_id}, "destination_id", f"root.start_location.destination_ids[{index}]")
        for index, destination_id in enumerate(destination_ids)
    )


def load_world(path: Path = DATA_PATH) -> StoryWorld:
    path = resolve_data_file(path)
    if path.suffix.lower() not in {".yaml", ".yml"}:
        raise ValueError(f"story data must be a story.qualms.yaml file or directory, got {path}")
    if not path.exists() or not path.read_text(encoding="utf-8").strip():
        write_blank_yaml_world(path)
    definition = load_game_definition(path)
    return load_world_from_raw(yaml_definition_to_raw(definition), rules_definition=definition)


def orbital_by_id(system: System, orbital_id: str) -> Orbital:
    for orbital in system.orbitals:
        if orbital.id == orbital_id:
            return orbital
    raise KeyError(orbital_id)


def validate_start_location(world: StoryWorld) -> None:
    if world.start_orbital_id is None:
        if world.start_destination_ids:
            raise ValueError("root.start_location.destination_ids requires orbital_id")
        return

    try:
        orbital = orbital_by_id(world.system_by_id(world.start_system), world.start_orbital_id)
    except KeyError as error:
        raise ValueError(f"root.start_location.orbital_id references unknown orbital {world.start_orbital_id}") from error

    try:
        destination_path_by_ids(orbital, world.start_destination_ids)
    except KeyError as error:
        raise ValueError(f"root.start_location.destination_ids references unknown destination {error.args[0]}") from error


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
        **(
            {
                "start_location": {
                    "system_id": world.start_system,
                    "orbital_id": world.start_orbital_id,
                    "destination_ids": list(world.start_destination_ids),
                }
            }
            if world.start_orbital_id
            else {}
        ),
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
                        **(
                            {"default_landing_destination_ids": list(orbital.default_landing_destination_ids)}
                            if orbital.default_landing_destination_ids
                            else {}
                        ),
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
        "id": option.id,
        "kind": option.kind,
        "name": option.name,
        "description": option.description,
        **({"port": option.port} if option.port else {}),
        **({"visible_when": list(option.visible_when)} if option.visible_when else {}),
        **({"visible_unless": list(option.visible_unless)} if option.visible_unless else {}),
        "objects": [
            {
                "id": story_object.id,
                "name": story_object.name,
                "description": story_object.description,
                "interactions": list(story_object.interactions),
                "collectable": story_object.collectable,
                **({"equipment_slot": story_object.equipment_slot} if story_object.equipment_slot else {}),
                **({"fuel_station": True} if story_object.fuel_station else {}),
                "before": before_rules_to_raw(story_object.before),
                "use_rules": use_rules_to_raw(story_object.use_rules),
                **({"visible_when": list(story_object.visible_when)} if story_object.visible_when else {}),
                **({"visible_unless": list(story_object.visible_unless)} if story_object.visible_unless else {}),
            }
            for story_object in option.objects
        ],
        "npcs": [
            {
                "id": npc.id,
                "name": npc.name,
                "description": npc.description,
                "examine_description": npc.examine_description,
                "interactions": list(npc.interactions),
                "before": before_rules_to_raw(npc.before),
                **({"visible_when": list(npc.visible_when)} if npc.visible_when else {}),
                **({"visible_unless": list(npc.visible_unless)} if npc.visible_unless else {}),
            }
            for npc in option.npcs
        ],
        "ships": [
            {
                "id": ship.id,
                "name": ship.name,
                "description": ship.description,
                "unlock": ship.unlock,
                "controlled": ship.controlled,
                "equipment_slots": list(ship.equipment_slots),
                "abilities": list(ship.abilities),
                "objects": [
                    {
                        "id": story_object.id,
                        "name": story_object.name,
                        "description": story_object.description,
                        "interactions": list(story_object.interactions),
                        "collectable": story_object.collectable,
                        **({"equipment_slot": story_object.equipment_slot} if story_object.equipment_slot else {}),
                        **({"fuel_station": True} if story_object.fuel_station else {}),
                        "before": before_rules_to_raw(story_object.before),
                        "use_rules": use_rules_to_raw(story_object.use_rules),
                        **({"visible_when": list(story_object.visible_when)} if story_object.visible_when else {}),
                        **({"visible_unless": list(story_object.visible_unless)} if story_object.visible_unless else {}),
                    }
                    for story_object in ship.objects
                ],
                "before": before_rules_to_raw(ship.before),
                "display_names": conditional_texts_to_raw(ship.display_names),
                "interior_descriptions": conditional_texts_to_raw(ship.interior_descriptions),
                "taglines": conditional_texts_to_raw(ship.taglines),
                **({"visible_when": list(ship.visible_when)} if ship.visible_when else {}),
                **({"visible_unless": list(ship.visible_unless)} if ship.visible_unless else {}),
            }
            for ship in option.ships
        ],
        "before": before_rules_to_raw(option.before),
        "sequences": [
            {
                "id": sequence.id,
                "when": list(sequence.when),
                "unless": list(sequence.unless),
                "messages": list(sequence.messages),
                "on_complete": list(sequence.on_complete),
            }
            for sequence in option.sequences
        ],
        **({"paths": list(option.paths)} if option.paths else {}),
        "destinations": [landing_option_to_raw(child) for child in option.destinations],
    }


def before_rules_to_raw(rules: tuple[BeforeRule, ...]) -> list[dict]:
    raw_rules = []
    for rule in rules:
        raw_rule = {
            "interaction": rule.interaction,
            "message": rule.message,
        }
        if rule.when:
            raw_rule["when"] = list(rule.when)
        if rule.unless:
            raw_rule["unless"] = list(rule.unless)
        if rule.on_complete:
            raw_rule["on_complete"] = list(rule.on_complete)
        raw_rules.append(raw_rule)
    return raw_rules


def use_rules_to_raw(rules: tuple[UseRule, ...]) -> list[dict]:
    raw_rules = []
    for rule in rules:
        raw_rule = {
            "target": rule.target,
            "messages": list(rule.messages),
            "on_complete": list(rule.on_complete),
        }
        if rule.when:
            raw_rule["when"] = list(rule.when)
        if rule.unless:
            raw_rule["unless"] = list(rule.unless)
        raw_rules.append(raw_rule)
    return raw_rules


def conditional_texts_to_raw(texts: tuple[ConditionalText, ...]) -> list[dict]:
    raw_texts = []
    for text in texts:
        raw_text = {"text": text.text}
        if text.when:
            raw_text["when"] = list(text.when)
        if text.unless:
            raw_text["unless"] = list(text.unless)
        raw_texts.append(raw_text)
    return raw_texts


def save_and_reload(path: Path, raw: dict) -> StoryWorld:
    if path.suffix.lower() not in {".yaml", ".yml"}:
        raise ValueError(f"story data must be a story.qualms.yaml file or directory, got {path}")
    world = load_world_from_raw(raw)
    write_story_world_yaml(world, path)
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
            "id": unique_id({destination.get("id") for destination in destinations if destination.get("id")}, slugify(name, "destination")),
            "kind": "Destination",
            "name": name,
            "description": description,
            "objects": [],
            "npcs": [],
            "ships": [],
            "before": [],
            "sequences": [],
            "destinations": [],
        }
    )
    return save_and_reload(path, raw)


def delete_landing_destination(
    world: StoryWorld,
    path: Path,
    system_id: str,
    orbital_id: str,
    parent_path: list[int],
    destination_index: int,
) -> StoryWorld:
    raw = world_to_raw(world)
    orbital_raw = orbital_raw_by_id(system_raw_by_id(raw, system_id), orbital_id)
    destinations = landing_destination_list_raw(orbital_raw, parent_path)
    if destination_index < 0 or destination_index >= len(destinations):
        raise ValueError("destination number is out of range")
    del destinations[destination_index]
    return save_and_reload(path, raw)


def add_object(
    world: StoryWorld,
    path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    name: str,
    description: str,
    interactions: tuple[str, ...],
) -> StoryWorld:
    raw = world_to_raw(world)
    orbital_raw = orbital_raw_by_id(system_raw_by_id(raw, system_id), orbital_id)
    destination_raw = landing_destination_raw(orbital_raw, destination_path)
    objects = destination_raw.setdefault("objects", [])
    if len(objects) >= 9:
        raise ValueError("destination already has 9 objects")
    if not interactions:
        raise ValueError("object must support at least one interaction")
    for interaction in interactions:
        if interaction not in OBJECT_INTERACTIONS:
            raise ValueError(f"interaction must be one of {sorted(OBJECT_INTERACTIONS)}")
    current_choice_count = sum(len(story_object.get("interactions", [story_object.get("kind", "Examine")])) for story_object in objects)
    current_choice_count += sum(len(npc.get("interactions", ["Examine", "Talk"])) for npc in destination_raw.setdefault("npcs", []))
    current_choice_count += sum(1 for _ship in destination_raw.setdefault("ships", []))
    current_choice_count += len(destination_raw.setdefault("destinations", []))
    if current_choice_count + len(interactions) > 9:
        raise ValueError("destination already has 9 numbered choices")
    objects.append(
        {
            "id": unique_id({story_object.get("id") for story_object in objects if story_object.get("id")}, slugify(name, "object")),
            "name": name,
            "description": description,
            "interactions": list(interactions),
            "collectable": "Take" in interactions,
            "before": [],
            "use_rules": [],
        }
    )
    destination_raw.pop("details", None)
    return save_and_reload(path, raw)


def add_npc(
    world: StoryWorld,
    path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    name: str,
    description: str,
    examine_description: str,
) -> StoryWorld:
    raw = world_to_raw(world)
    orbital_raw = orbital_raw_by_id(system_raw_by_id(raw, system_id), orbital_id)
    destination_raw = landing_destination_raw(orbital_raw, destination_path)
    npcs = destination_raw.setdefault("npcs", [])
    if len(npcs) >= 9:
        raise ValueError("destination already has 9 NPCs")
    objects = destination_raw.setdefault("objects", [])
    current_choice_count = sum(len(story_object.get("interactions", [story_object.get("kind", "Examine")])) for story_object in objects)
    current_choice_count += sum(len(npc.get("interactions", ["Examine", "Talk"])) for npc in npcs)
    current_choice_count += sum(1 for _ship in destination_raw.setdefault("ships", []))
    current_choice_count += len(destination_raw.setdefault("destinations", []))
    if current_choice_count + 2 > 9:
        raise ValueError("destination already has 9 numbered choices")
    npcs.append(
        {
            "id": unique_id({npc.get("id") for npc in npcs if npc.get("id")}, slugify(name, "npc")),
            "name": name,
            "description": description,
            "examine_description": examine_description,
            "interactions": ["Examine", "Talk"],
            "before": [],
        }
    )
    return save_and_reload(path, raw)


def delete_object(
    world: StoryWorld,
    path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    object_index: int,
) -> StoryWorld:
    raw = world_to_raw(world)
    orbital_raw = orbital_raw_by_id(system_raw_by_id(raw, system_id), orbital_id)
    destination_raw = landing_destination_raw(orbital_raw, destination_path)
    objects = destination_raw.setdefault("objects", [])
    if object_index < 0 or object_index >= len(objects):
        raise ValueError("object number is out of range")
    del objects[object_index]
    destination_raw.pop("details", None)
    return save_and_reload(path, raw)


def delete_npc(
    world: StoryWorld,
    path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    npc_index: int,
) -> StoryWorld:
    raw = world_to_raw(world)
    orbital_raw = orbital_raw_by_id(system_raw_by_id(raw, system_id), orbital_id)
    destination_raw = landing_destination_raw(orbital_raw, destination_path)
    npcs = destination_raw.setdefault("npcs", [])
    if npc_index < 0 or npc_index >= len(npcs):
        raise ValueError("NPC number is out of range")
    del npcs[npc_index]
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
    footer: str | None = None,
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
        if footer:
            label = f"[ {footer} ]"
            footer_x = left + max(1, ((right - left + 1) - len(label)) // 2)
            if footer_x + len(label) < right:
                stdscr.addstr(bottom, footer_x, label, curses.color_pair(1))
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


def bottom_window(stdscr: curses.window, width: int, lines: Iterable[str], top: int | None = None) -> None:
    rows, cols = stdscr.getmaxyx()
    width = min(width, cols)
    content_width = max(10, width - 4)
    text = wrap_lines(lines, content_width)
    height = len(text) + 4
    if top is None:
        top = max(0, rows - height - 1)
    else:
        top = max(0, min(top, rows - height))
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


CLI_BRIGHT = "\033[1m"
CLI_CYAN = "\033[36m"
CLI_GRAY = "\033[90m"
CLI_RESET = "\033[0m"


def cli_style_enabled() -> bool:
    isatty = getattr(sys.stdout, "isatty", None)
    return callable(isatty) and bool(isatty())


def bright_cli_text(text: str) -> str:
    return f"{CLI_BRIGHT}{text}{CLI_RESET}" if text else text


def color_cli_text(text: str, color: str) -> str:
    return f"{color}{text}{CLI_RESET}" if text else text


def coauthor_line_color(line: str) -> str | None:
    stripped = line.lstrip()
    if stripped.startswith(("Coauthor:", "Agent:", "Summary:", "Feedback:")):
        return CLI_CYAN
    if stripped.startswith(("Tool call:", "Tool result:")):
        return CLI_GRAY
    return None


def style_generic_name_list(line: str) -> str:
    for pattern in (
        r"^(You see: )(.+)(\.)$",
        r"^(You can see )(.+)(\.)$",
        r"^(Inventory: )(.+)(\.)$",
        r"^(You are carrying )(.+)(\.)$",
    ):
        match = re.match(pattern, line)
        if match and match.group(2).lower() != "empty":
            return f"{match.group(1)}{bright_cli_text(match.group(2))}{match.group(3)}"
    return line


def command_prompt_text() -> str:
    return "> "


def coauthor_prompt_text() -> str:
    return "coauthor> "


def coauthor_command_words() -> list[str]:
    return ["story", "exit coauthor", "exit prompt", "quit", "exit"]


def terminal_dimensions() -> tuple[int, int]:
    size = shutil.get_terminal_size(fallback=(80, 24))
    return max(40, min(100, size.columns)), max(8, size.lines)


def append_text_block(lines: list[str], text: str) -> None:
    for line in text.splitlines() or ([text] if text else []):
        lines.append(line)


def combine_message_texts(messages: Iterable[str]) -> str:
    return "\n".join(message for message in messages if message)


def append_gameplay_screen(state: GameState, lines: list[str]) -> None:
    if not state.editor_enabled or not lines or state.coauthor_mode:
        return
    if any(line.startswith("Coauthor:") for line in lines):
        return
    append_gameplay_entry(state, "Story", "\n".join(lines))


def append_gameplay_entry(state: GameState, speaker: str, text: str) -> None:
    if not state.editor_enabled:
        return
    clean = text.strip()
    if not clean:
        return
    entry = f"{speaker}:\n{clean}" if "\n" in clean else f"{speaker}: {clean}"
    if state.gameplay_history and state.gameplay_history[-1] == entry:
        return
    state.gameplay_history.append(entry)
    if len(state.gameplay_history) > MAX_GAMEPLAY_HISTORY:
        del state.gameplay_history[: len(state.gameplay_history) - MAX_GAMEPLAY_HISTORY]


def gameplay_history_text(state: GameState) -> str:
    text = "\n\n".join(state.gameplay_history[-MAX_GAMEPLAY_HISTORY:])
    return text[-6000:]


def game_window(stdscr: curses.window, state: GameState, width: int, lines: Iterable[str]) -> None:
    margin = editor_box_margin(stdscr, state)
    top, _left, _content_width, text = centered_window(stdscr, width, lines, bottom_margin=margin)
    if margin:
        state.editor_box_top = top + len(text) + 5
    else:
        state.editor_box_top = None


class CliPrompter:
    def __init__(self) -> None:
        self._session: Any | None = None
        self._word_completer: Any | None = None
        self._path_completer: Any | None = None
        self._prompt_toolkit_available = False
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            return
        try:
            from prompt_toolkit import PromptSession
            from prompt_toolkit.completion import FuzzyCompleter, PathCompleter, WordCompleter
            from prompt_toolkit.history import InMemoryHistory
        except ModuleNotFoundError:
            return

        self._prompt_toolkit_available = True
        self._session = PromptSession(history=InMemoryHistory())
        self._word_completer = lambda words: FuzzyCompleter(WordCompleter(words, ignore_case=True))
        self._path_completer = PathCompleter

    def read_command(
        self,
        completions: Iterable[str],
        prompt_text: str | None = None,
        allow_blank_tab_toggle: bool = False,
    ) -> str | None:
        completion_words = sorted({word for word in completions if word})
        print()
        prompt_value = prompt_text or command_prompt_text()
        if not self._prompt_toolkit_available:
            try:
                return input(prompt_value)
            except EOFError:
                return None
            except KeyboardInterrupt:
                print()
                return ""

        completer = self._word_completer(completion_words) if completion_words else None
        key_bindings = self.blank_tab_key_bindings() if allow_blank_tab_toggle else None
        try:
            return self._session.prompt(
                prompt_value,
                completer=completer,
                complete_while_typing=True,
                key_bindings=key_bindings,
            )
        except EOFError:
            return None
        except KeyboardInterrupt:
            print()
            return ""

    def blank_tab_key_bindings(self) -> Any:
        from prompt_toolkit.key_binding import KeyBindings

        bindings = KeyBindings()

        @bindings.add("tab")
        def _(event: Any) -> None:
            if event.current_buffer.text.strip():
                event.current_buffer.start_completion(select_first=False)
                return
            event.app.exit(result=CLI_TOGGLE_COAUTHOR)

        return bindings

    def prompt_text(
        self,
        title: str,
        prompt: str,
        context_lines: Iterable[str] = (),
        max_length: int = 64,
        default: str | None = None,
    ) -> str | None:
        self.print_prompt_context(title, context_lines)
        prompt_line = prompt_label(prompt, default)
        if not self._prompt_toolkit_available:
            try:
                value = input(f"{prompt_line} ")
            except EOFError:
                return None
            except KeyboardInterrupt:
                print()
                return None
            return value[:max_length].strip() or default

        completer = self._path_completer(expanduser=True) if "filename" in prompt.lower() else None
        try:
            value = self._session.prompt(
                f"{prompt_line} ",
                default=default or "",
                completer=completer,
            )
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        return value[:max_length].strip() or default

    def prompt_multiline_text(
        self,
        title: str,
        prompt: str,
        context_lines: Iterable[str] = (),
        default: str | None = None,
    ) -> str | None:
        help_line = "Alt-Enter saves. Ctrl-C cancels."
        self.print_prompt_context(title, [*context_lines, help_line])
        prompt_line = prompt_label(prompt, default)
        if not self._prompt_toolkit_available:
            print(prompt_line)
            print("End with a single '.' line. Leave blank to keep the default.")
            lines: list[str] = []
            while True:
                try:
                    line = input("| ")
                except EOFError:
                    break
                except KeyboardInterrupt:
                    print()
                    return None
                if line == ".":
                    break
                lines.append(line)
            value = "\n".join(lines).strip()
            return value or default

        try:
            value = self._session.prompt(
                f"{prompt_line} ",
                default=default or "",
                multiline=True,
                prompt_continuation="... ",
            )
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        return value.strip() or default

    def prompt_menu(self, title: str, options: list[str]) -> int | None:
        words = [str(index) for index in range(1, len(options) + 1)]
        words.extend(option.lower() for option in options)
        words.extend(["g", "go back", "back"])
        while True:
            context = [f"{index}. {option}" for index, option in enumerate(options, start=1)]
            self.print_prompt_context(title, [*context, "", "G: go back"])
            value = self.read_command(words)
            if value is None:
                return None
            normalized = normalize_command(value)
            if normalized in {"g", "go back", "back"}:
                return None
            if normalized.isdigit():
                index = int(normalized) - 1
                if 0 <= index < len(options):
                    return index
            for index, option in enumerate(options):
                if normalized == option.lower():
                    return index
            print("Choose a listed number, or G to go back.")

    def print_prompt_context(self, title: str, context_lines: Iterable[str]) -> None:
        lines = list(context_lines)
        print()
        print(title)
        print()
        for line in lines:
            print(line)
        if lines:
            print()


def normalize_command(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def is_cli_prompter(value: Any) -> bool:
    return isinstance(value, CliPrompter)


def prompt_text(
    stdscr: Any,
    title: str,
    prompt: str,
    context_lines: Iterable[str] = (),
    max_length: int = 64,
    default: str | None = None,
) -> str | None:
    if is_cli_prompter(stdscr):
        return stdscr.prompt_text(title, prompt, context_lines, max_length, default)

    curses.echo()
    try:
        curses.curs_set(1)
    except curses.error:
        pass

    stdscr.erase()
    context = list(context_lines)
    prompt_line = prompt_label(prompt, default)
    top, left, _content_width, rendered_lines = centered_window(stdscr, 72, [title, "", *context, prompt_line])
    rows, cols = stdscr.getmaxyx()
    input_y = top + 2 + len(rendered_lines) - 1
    input_x = left + 2 + len(prompt_line) + 1
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
    return value or default


def prompt_multiline_text(
    stdscr: Any,
    title: str,
    prompt: str,
    context_lines: Iterable[str] = (),
    default: str | None = None,
) -> str | None:
    if is_cli_prompter(stdscr):
        return stdscr.prompt_multiline_text(title, prompt, context_lines, default)

    text = ""
    save_help = "Type freely. Enter keeps the default when blank. Ctrl-D saves. Ctrl-C cancels."
    if default is None:
        save_help = "Type freely. Ctrl-D saves. Ctrl-C cancels."
    context = [*context_lines, save_help, ""]
    prompt_line = prompt_label(prompt, default)

    try:
        curses.curs_set(1)
    except curses.error:
        pass

    while True:
        stdscr.erase()
        rows, cols = stdscr.getmaxyx()
        content_width = max(10, min(72, cols - 4) - 4)
        display_lines = [title, "", *context, prompt_line, *text_area_lines(text, content_width)]
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
            return text.strip() or default
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
            if default is not None and not text.strip():
                try:
                    curses.curs_set(0)
                except curses.error:
                    pass
                return default
            text += "\n"
            continue
        if 0 <= key < 256 and chr(key).isprintable():
            text += chr(key)


def prompt_label(prompt: str, default: str | None = None) -> str:
    if default is None:
        return prompt
    base = prompt.strip()
    if base.endswith(":"):
        base = base[:-1].rstrip()
    return f"{base} [{preview_text(default)}]:"


def preview_text(value: str, max_length: int = 32) -> str:
    preview = re.sub(r"\s+", " ", value).strip()
    if not preview:
        return "empty"
    if len(preview) <= max_length:
        return preview
    return preview[: max_length - 3].rstrip() + "..."


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
    stdscr: Any,
    title: str,
    current_name: str | None = None,
    current_description: str | None = None,
) -> tuple[str, str] | None:
    context = []

    name = prompt_text(stdscr, title, "Name:", context, default=current_name)
    if name is None:
        return None
    description = prompt_multiline_text(stdscr, title, "Description", context, default=current_description)
    if description is None:
        return None
    return name, description


def prompt_menu(stdscr: Any, title: str, options: list[str]) -> int | None:
    if is_cli_prompter(stdscr):
        return stdscr.prompt_menu(title, options)

    while True:
        lines = [title, ""]
        for index, option in enumerate(options, start=1):
            lines.append(f"{index}. {option}")
        lines.extend(["", "G: go back"])
        stdscr.erase()
        centered_window(stdscr, 72, lines)
        stdscr.refresh()
        key = stdscr.getch()
        if key in (ord("g"), ord("G")):
            return None
        index = key - ord("1")
        if 0 <= index < len(options):
            return index


def default_save_path(data_path: Path) -> Path:
    return data_path.resolve().with_suffix(".save.json")


def resolve_save_path(value: str, data_path: Path) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return data_path.resolve().parent / path


def game_state_to_save_data(state: GameState) -> dict[str, Any]:
    saved_view = state.menu_return_view if state.view == "main_menu" else state.view
    return {
        "qualms_save": SAVE_FORMAT_VERSION,
        "state": {
            "system_id": state.system_id,
            "view": saved_view,
            "menu_return_view": state.menu_return_view,
            "map_return_view": state.map_return_view,
            "inventory_return_view": state.inventory_return_view,
            "use_return_view": state.use_return_view,
            "orbital_id": state.orbital_id,
            "docked_path": list(state.docked_path),
            "destination_path": list(state.destination_path),
            "current_location_id": state.current_location_id,
            "player_ship_id": state.player_ship_id,
            "boarded_ship_id": state.boarded_ship_id,
            "inventory_index": state.inventory_index,
            "inventory": list(state.inventory),
            "equipment": dict(state.equipment),
            "object_locations": dict(state.object_locations),
            "ship_locations": dict(state.ship_locations),
            "ship_fuel": dict(state.ship_fuel),
            "facts": sorted(state.facts),
            "last_system_id": state.last_system_id,
            "last_orbital_by_system": dict(state.last_orbital_by_system),
        },
    }


def write_save_game(path: Path, state: GameState) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(game_state_to_save_data(state), indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_save_game(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("qualms_save") != SAVE_FORMAT_VERSION:
        raise ValueError("unsupported save file")
    state_data = data.get("state")
    if not isinstance(state_data, dict):
        raise ValueError("save file is missing state")
    return data


def generic_cli_state_to_save_data(state: GenericCliState) -> dict[str, Any]:
    return {
        "qualms_generic_save": GENERIC_SAVE_FORMAT_VERSION,
        "actor_id": state.actor_id,
        "message": state.message,
        "pending_messages": list(state.pending_messages),
        "pending_index": state.pending_index,
        "runtime_state": generic_world_state_to_save_data(state.runtime_state),
    }


def generic_world_state_to_save_data(state: WorldState) -> dict[str, Any]:
    return {
        "entities": {
            entity_id: {
                "metadata": json_safe_value(entity.metadata),
                "traits": {
                    trait_id: {
                        "parameters": json_safe_value(trait.parameters),
                        "fields": json_safe_value(trait.fields),
                    }
                    for trait_id, trait in entity.traits.items()
                },
            }
            for entity_id, entity in state.entities.items()
        },
        "memory": fact_store_to_save_data(state.memory.facts),
        "current_relations": relation_store_to_save_data(state.current_relations),
        "remembered_relations": relation_store_to_save_data(state.remembered_relations),
        "events": json_safe_value(state.events),
        "allocators": dict(state.allocators),
    }


def json_safe_value(value: Any) -> Any:
    if isinstance(value, tuple):
        return [json_safe_value(item) for item in value]
    if isinstance(value, list):
        return [json_safe_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): json_safe_value(item) for key, item in value.items()}
    return value


def fact_store_to_save_data(facts: set[tuple[str, tuple[Any, ...]]]) -> list[dict[str, Any]]:
    return [
        {"id": fact_id, "args": json_safe_value(args)}
        for fact_id, args in sorted(facts, key=lambda item: (item[0], repr(item[1])))
    ]


def relation_store_to_save_data(relations: set[tuple[str, tuple[Any, ...]]]) -> list[dict[str, Any]]:
    return [
        {"relation": relation_id, "args": json_safe_value(args)}
        for relation_id, args in sorted(relations, key=lambda item: (item[0], repr(item[1])))
    ]


def write_generic_save_game(path: Path, state: GenericCliState) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = generic_cli_state_to_save_data(state)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_generic_save_game(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("qualms_generic_save") != GENERIC_SAVE_FORMAT_VERSION:
        raise ValueError("unsupported generic CLI save file")
    if not isinstance(data.get("runtime_state"), dict):
        raise ValueError("generic CLI save file is missing runtime_state")
    return data


def restore_generic_cli_state(definition: Any, data: dict[str, Any]) -> GenericCliState:
    runtime_state = restore_generic_world_state(definition, require_saved_object(data, "runtime_state"))
    actor_id = data.get("actor_id")
    if not isinstance(actor_id, str) or actor_id not in runtime_state.entities or not runtime_state.has_trait(actor_id, "Actor"):
        raise ValueError("generic CLI save file references an unknown actor")
    if generic_cli_current_location_id(runtime_state, actor_id) is None:
        raise ValueError("generic CLI save file has no current actor location")
    message = data.get("message", "")
    if not isinstance(message, str):
        raise ValueError("message must be a string")
    return GenericCliState(
        definition=definition,
        runtime_state=runtime_state,
        engine=RulesEngine(definition),
        actor_id=actor_id,
        message=message,
        pending_messages=tuple(saved_string_list(data.get("pending_messages", []), "pending_messages")),
        pending_index=int(data.get("pending_index", 0) or 0),
    )


def restore_generic_world_state(definition: Any, raw_state: dict[str, Any]) -> WorldState:
    state = WorldState(definition=definition)
    raw_entities = require_saved_object(raw_state, "entities")
    for entity_id, raw_entity in raw_entities.items():
        if not isinstance(raw_entity, dict):
            raise ValueError(f"entity {entity_id} must be an object")
        entity = Entity(id=str(entity_id), metadata=dict(raw_entity.get("metadata", {})))
        raw_traits = raw_entity.get("traits", {})
        if not isinstance(raw_traits, dict):
            raise ValueError(f"entity {entity_id}.traits must be an object")
        for trait_id, raw_trait in raw_traits.items():
            if not isinstance(raw_trait, dict):
                raise ValueError(f"trait {entity_id}.{trait_id} must be an object")
            parameters = raw_trait.get("parameters", {})
            fields = raw_trait.get("fields", {})
            if not isinstance(parameters, dict) or not isinstance(fields, dict):
                raise ValueError(f"trait {entity_id}.{trait_id} parameters and fields must be objects")
            entity.traits[str(trait_id)] = TraitInstance(
                definition_id=str(trait_id),
                parameters=dict(parameters),
                fields=dict(fields),
            )
        state.entities[entity.id] = entity

    state.memory.facts = saved_fact_store(raw_state.get("memory", []), "memory")
    state.current_relations = saved_relation_store(raw_state.get("current_relations", []), "current_relations")
    state.remembered_relations = saved_relation_store(raw_state.get("remembered_relations", []), "remembered_relations")
    raw_events = raw_state.get("events", [])
    if not isinstance(raw_events, list) or not all(isinstance(event, dict) for event in raw_events):
        raise ValueError("events must be a list of objects")
    state.events = list(raw_events)
    raw_allocators = raw_state.get("allocators", {})
    if not isinstance(raw_allocators, dict):
        raise ValueError("allocators must be an object")
    state.allocators = {str(key): int(value) for key, value in raw_allocators.items()}
    return state


def require_saved_object(raw_state: dict[str, Any], field: str) -> dict[str, Any]:
    value = raw_state.get(field)
    if not isinstance(value, dict):
        raise ValueError(f"{field} must be an object")
    return value


def saved_fact_store(value: Any, field: str) -> set[tuple[str, tuple[Any, ...]]]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be a list")
    facts: set[tuple[str, tuple[Any, ...]]] = set()
    for index, raw_fact in enumerate(value):
        if not isinstance(raw_fact, dict) or not isinstance(raw_fact.get("id"), str):
            raise ValueError(f"{field}[{index}] must define id")
        raw_args = raw_fact.get("args", [])
        if not isinstance(raw_args, list):
            raise ValueError(f"{field}[{index}].args must be a list")
        facts.add((raw_fact["id"], tuple(saved_hashable_value(arg) for arg in raw_args)))
    return facts


def saved_relation_store(value: Any, field: str) -> set[tuple[str, tuple[Any, ...]]]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be a list")
    relations: set[tuple[str, tuple[Any, ...]]] = set()
    for index, raw_relation in enumerate(value):
        if not isinstance(raw_relation, dict) or not isinstance(raw_relation.get("relation"), str):
            raise ValueError(f"{field}[{index}] must define relation")
        raw_args = raw_relation.get("args", [])
        if not isinstance(raw_args, list):
            raise ValueError(f"{field}[{index}].args must be a list")
        relations.add((raw_relation["relation"], tuple(saved_hashable_value(arg) for arg in raw_args)))
    return relations


def saved_hashable_value(value: Any) -> Any:
    if isinstance(value, list):
        return tuple(saved_hashable_value(item) for item in value)
    if isinstance(value, dict):
        return tuple(sorted((key, saved_hashable_value(item)) for key, item in value.items()))
    return value


def restore_game_state(world: StoryWorld, data: dict[str, Any], editor_enabled: bool) -> GameState:
    raw_state = data.get("state")
    if not isinstance(raw_state, dict):
        raise ValueError("save file is missing state")

    state = initial_game_state(world, editor_enabled)
    state.system_id = require_saved_string(raw_state, "system_id", state.system_id)
    world.system_by_id(state.system_id)
    state.view = require_saved_string(raw_state, "view", "system")
    state.menu_return_view = require_saved_string(raw_state, "menu_return_view", "system")
    state.map_return_view = require_saved_string(raw_state, "map_return_view", "system")
    state.inventory_return_view = require_saved_string(raw_state, "inventory_return_view", "system")
    state.use_return_view = require_saved_string(raw_state, "use_return_view", "inventory")
    state.orbital_id = optional_saved_string(raw_state.get("orbital_id"))
    if state.orbital_id is not None:
        orbital_by_id(world.system_by_id(state.system_id), state.orbital_id)
    state.docked_path = saved_int_list(raw_state.get("docked_path", []), "docked_path")
    state.destination_path = saved_int_list(raw_state.get("destination_path", []), "destination_path")
    state.current_location_id = optional_saved_string(raw_state.get("current_location_id")) or state.current_location_id
    state.player_ship_id = known_saved_id(raw_state.get("player_ship_id"), state.ships)
    state.boarded_ship_id = known_saved_id(raw_state.get("boarded_ship_id"), state.ships)
    state.inventory_index = int(raw_state.get("inventory_index", 0) or 0)

    objects = objects_by_id(world)
    state.inventory = {
        item_id: objects[item_id]
        for item_id in saved_string_list(raw_state.get("inventory", []), "inventory")
        if item_id in objects
    }
    state.equipment = {
        str(slot): item_id
        for slot, item_id in saved_string_mapping(raw_state.get("equipment", {}), "equipment").items()
        if item_id in objects
    }
    state.object_locations = saved_string_mapping(raw_state.get("object_locations", {}), "object_locations")

    saved_ship_locations = saved_string_mapping(raw_state.get("ship_locations", {}), "ship_locations")
    state.ship_locations = {
        ship_id: saved_ship_locations.get(ship_id, state.ship_locations.get(ship_id, "unknown"))
        for ship_id in state.ships
    }
    saved_ship_fuel = raw_state.get("ship_fuel", {})
    if not isinstance(saved_ship_fuel, dict):
        raise ValueError("ship_fuel must be an object")
    state.ship_fuel = {
        ship_id: int(saved_ship_fuel.get(ship_id, state.ship_fuel.get(ship_id, 0)) or 0)
        for ship_id in state.ships
    }
    state.facts = set(saved_string_list(raw_state.get("facts", []), "facts"))
    state.last_system_id = optional_saved_string(raw_state.get("last_system_id"))
    state.last_orbital_by_system = saved_string_mapping(raw_state.get("last_orbital_by_system", {}), "last_orbital_by_system")

    if state.orbital_id is None:
        state.docked_path.clear()
        state.destination_path.clear()
    else:
        orbital = orbital_by_id(world.system_by_id(state.system_id), state.orbital_id)
        if state.destination_path and destination_at_path(orbital, state.destination_path) is None:
            raise ValueError("saved destination no longer exists")
        if state.docked_path and destination_at_path(orbital, state.docked_path) is None:
            raise ValueError("saved docked destination no longer exists")

    clear_notice(state)
    state.sequence_messages = ()
    state.sequence_index = 0
    state.sequence_on_complete = ()
    state.use_source_item_id = None
    state.message = ""
    attach_rules_runtime(world, state)
    return state


def require_saved_string(raw_state: dict[str, Any], field: str, default: str) -> str:
    value = raw_state.get(field, default)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value


def optional_saved_string(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError("saved id must be a non-empty string")
    return value


def known_saved_id(value: Any, known: dict[str, Any]) -> str | None:
    item_id = optional_saved_string(value)
    if item_id is None or item_id in known:
        return item_id
    return None


def saved_int_list(value: Any, field: str) -> list[int]:
    if not isinstance(value, list) or not all(isinstance(item, int) for item in value):
        raise ValueError(f"{field} must be a list of integers")
    return list(value)


def saved_string_list(value: Any, field: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{field} must be a list of strings")
    return list(value)


def saved_string_mapping(value: Any, field: str) -> dict[str, str]:
    if not isinstance(value, dict) or not all(isinstance(key, str) and isinstance(item, str) for key, item in value.items()):
        raise ValueError(f"{field} must be an object of strings")
    return dict(value)


def main_menu_lines(state: GameState) -> list[str]:
    lines = [
        "Dark Qualms",
        "",
        "1. Continue",
        "2. New game",
        "3. Save",
        "4. Restore",
        "5. Quit",
    ]
    if state.message:
        lines.extend(["", state.message])
    return lines


def system_lines(world: StoryWorld, state: GameState, system: System) -> list[str]:
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
    lines.extend(["", "Number: travel", "I: inventory", "L: leave system    M: map    Q: menu"])
    return lines


def jump_list_lines(world: StoryWorld, state: GameState, system: System) -> list[str]:
    lines = [
        "Leave System",
        "",
        f"Current: {system.name}",
        f"Sol offset: {format_signed_au(system.position_au[0])}, {format_signed_au(system.position_au[1])}",
        *ship_status_lines(state, state.ships.get(state.boarded_ship_id or state.player_ship_id or "")),
        "",
        "Jump points:",
    ]
    for index, hop in enumerate(sorted_hops(world, system), start=1):
        dx = hop.position_au[0]
        dy = hop.position_au[1]
        distance = system_distance_au(system, hop)
        lines.append(f"{index}. {hop.name} [{format_signed_au(dx)}, {format_signed_au(dy)}] {distance:.0f} AU")
    lines.extend(["", "Number: jump", "G: go back    I: inventory    M: map    Q: menu"])
    return lines


def map_lines(world: StoryWorld, system: System) -> list[str]:
    return [
        "Local Map",
        "",
        *build_map_lines(world, system),
        "",
        "@ current    * system    lines: available jumps",
        "G: go back",
        "I: inventory",
        "Q: menu",
    ]


def orbit_lines(state: GameState, orbital: Orbital) -> list[str]:
    lines = [
        destination_status(orbital),
        "",
        orbital.description,
        "",
    ]
    ship = boarded_ship(state)
    if ship is not None:
        lines.extend([f"Aboard: {ship.name}", ""])
    lines.extend([
        "L: land",
        "I: inventory",
        "T: travel in-system",
        "Q: menu",
    ])
    return lines


def option_lines(state: GameState, orbital: Orbital, option: LandingOption) -> list[str]:
    lines = [
        f"{orbital.name}: {option.name}",
        "",
        option.description,
        "",
    ]
    choice_number = 1
    object_choices = object_choices_for_destination(state, option)
    if object_choices:
        lines.append("Objects:")
        for choice in object_choices:
            lines.append(f"{choice_number}. {choice.target.name} [{choice.interaction}]")
            choice_number += 1
        lines.append("")

    npc_choices = npc_choices_for_destination(state, option)
    if npc_choices:
        lines.append("People:")
        for npc in visible_npcs_for_destination(state, option):
            lines.append(npc.description)
        for choice in npc_choices:
            lines.append(f"{choice_number}. {choice.target.name} [{choice.interaction}]")
            choice_number += 1
        lines.append("")

    ship_choices = ship_choices_for_destination(state, option)
    visible_ships = visible_ships_for_destination(state, option)
    if visible_ships:
        lines.append("Ships:")
        for ship in visible_ships:
            lines.append(ship_tagline(state, option, ship))
        for choice in ship_choices:
            lines.append(f"{choice_number}. {interaction_choice_label(state, choice)} [{choice.interaction}]")
            choice_number += 1
        lines.append("")

    visible_destination_entries_list = visible_destination_entries(state, option)
    if visible_destination_entries_list:
        lines.append("Destinations:")
    for _child_index, child in visible_destination_entries_list:
        lines.append(f"{choice_number}. {child.name} [{child.kind}]")
        choice_number += 1
    lines.append("")
    boardable_ships = boardable_ships_for_destination(state, option)
    if len(boardable_ships) == 1:
        lines.append(f"B: board {ship_display_name(state, boardable_ships[0])}")
    elif boardable_ships:
        lines.append("B: board ship")
    if state.destination_path != state.docked_path:
        lines.append("G: go back")
    lines.extend([
        "I: inventory",
        "Q: menu",
    ])
    return lines


def boarded_ship_lines(state: GameState, destination: LandingOption | None = None) -> list[str]:
    ship = boarded_ship(state)
    name = ship.name if ship is not None else "Ship"
    lines = [
        f"On board the {name}",
        "",
    ]
    status = ship_status_lines(state, ship)
    if status:
        lines.extend([*status, ""])
    description = ship_interior_description(state, ship)
    if description:
        lines.extend([description, ""])
    object_choices = ship_object_choices(state, ship)
    if object_choices:
        lines.append("Objects:")
        for index, choice in enumerate(object_choices, start=1):
            lines.append(f"{index}. {choice.target.name} [{choice.interaction}]")
        lines.append("")
    if ship is not None and ship_controlled_by_player(state, ship):
        lines.append("T: take off")
    if ship is not None and destination is not None and can_refuel_boarded_ship(state, destination, ship):
        lines.append("F: refuel")
    lines.extend(["G: go back", "I: inventory", "Q: menu"])
    return lines


def sequence_lines(state: GameState) -> list[str]:
    message = state.sequence_messages[state.sequence_index] if sequence_active(state) else ""
    return [message, "", "Press Enter to continue"]


def continue_message_lines(state: GameState) -> list[str]:
    return [state.continue_message, "", "Press Enter to continue"]


def inventory_lines(state: GameState) -> list[str]:
    items = inventory_items(state)
    if state.inventory_index >= len(items):
        state.inventory_index = max(0, len(items) - 1)

    lines = ["Inventory", ""]
    if not items:
        lines.append("Nothing.")
    else:
        equipped_ids = set(state.equipment.values())
        for index, item in enumerate(items, start=1):
            marker = ">" if index - 1 == state.inventory_index else " "
            equipped = "*" if item.id in equipped_ids else " "
            item_type = f" [{item.equipment_slot.lower()}]" if item.equipment_slot else ""
            lines.append(f"{index}. {marker}{equipped} {item.name}{item_type}")

    if state.message:
        lines.extend(["", state.message])

    lines.append("")
    if items:
        lines.extend(["Number: select", "X: examine"])
        selected = items[state.inventory_index]
        if selected.equipment_slot:
            lines.append("E: equip")
        if "Use" in selected.interactions:
            lines.append("U: use")
    lines.extend(["G: go back", "Q: menu"])
    return lines


def use_scope_lines(state: GameState) -> list[str]:
    source = selected_use_source(state)
    title = f"Use: {source.name}" if source is not None else "Use"
    return [
        title,
        "",
        "1. on an object in your inventory",
        "2. on something in the room",
        "",
        "G: go back",
        "Q: menu",
    ]


def use_targets_lines(world: StoryWorld, state: GameState) -> list[str]:
    source = selected_use_source(state)
    title = f"Use: {source.name}" if source is not None else "Use"
    targets = use_targets(world, state)
    lines = [title, ""]
    if targets:
        for index, target in enumerate(targets, start=1):
            lines.append(f"{index}. {target.name}")
    else:
        lines.append("Nothing.")
    lines.extend(["", "G: go back", "Q: menu"])
    return lines


def current_screen_lines(world: StoryWorld, state: GameState) -> list[str]:
    system = world.system_by_id(state.system_id)

    if state.continue_message:
        return continue_message_lines(state)
    if sequence_active(state):
        return sequence_lines(state)
    if state.view == "main_menu":
        return main_menu_lines(state)
    if state.view == "use_scope":
        return use_scope_lines(state)
    if state.view in {"use_room_target", "use_inventory_target"}:
        return use_targets_lines(world, state)
    if state.view == "inventory":
        return inventory_lines(state)
    if state.view == "jump":
        return jump_list_lines(world, state, system)
    if state.view == "map":
        return map_lines(world, system)
    if state.orbital_id is None:
        return system_lines(world, state, system)

    orbital = orbital_by_id(system, state.orbital_id)
    selected_destination = destination_at_path(orbital, state.destination_path)
    if selected_destination is not None:
        state.current_location_id = selected_destination.id
        enter_destination(state, selected_destination)
    if sequence_active(state):
        return sequence_lines(state)
    if selected_destination is not None and boarded_ship_at_destination(state, selected_destination):
        return boarded_ship_lines(state, selected_destination)
    if selected_destination is not None:
        return option_lines(state, orbital, selected_destination)
    return orbit_lines(state, orbital)


def draw_main_menu(stdscr: curses.window, state: GameState) -> None:
    centered_window(stdscr, 72, main_menu_lines(state))


def draw_system(stdscr: curses.window, world: StoryWorld, state: GameState, system: System) -> None:
    game_window(stdscr, state, 72, system_lines(world, state, system))


def draw_jump_list(stdscr: curses.window, world: StoryWorld, state: GameState, system: System) -> None:
    game_window(stdscr, state, 80, jump_list_lines(world, state, system))


def draw_map(stdscr: curses.window, world: StoryWorld, state: GameState, system: System) -> None:
    centered_window(stdscr, 76, map_lines(world, system))


def draw_orbit(stdscr: curses.window, state: GameState, orbital: Orbital) -> None:
    game_window(stdscr, state, 72, orbit_lines(state, orbital))


def draw_option(stdscr: curses.window, state: GameState, orbital: Orbital, option: LandingOption) -> None:
    game_window(stdscr, state, 72, option_lines(state, orbital, option))


def draw_boarded_ship(stdscr: curses.window, state: GameState, destination: LandingOption | None = None) -> None:
    game_window(stdscr, state, 72, boarded_ship_lines(state, destination))


def editor_commands_for_state(state: GameState) -> list[str]:
    if not state.editor_enabled:
        return []
    if state.view == "main_menu":
        return []
    if sequence_active(state) or state.continue_message or state.view in {"map", "inventory"}:
        return ["R: reload", "prompt: coauthor"]
    if state.view == "jump":
        return ["A: add system", "R: reload", "prompt: coauthor"]
    if state.destination_path:
        return ["A: add", "D: delete detail", "E: edit destination", "R: reload", "prompt: coauthor"]
    if state.orbital_id is None:
        return ["A: add orbital", "D: delete orbital", "E: edit system", "R: reload", "prompt: coauthor"]
    return ["E: edit orbital", "R: reload", "prompt: coauthor"]


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
    bottom_window(stdscr, 72, lines, top=state.editor_box_top)


def draw_sequence(stdscr: curses.window, state: GameState) -> None:
    centered_window(stdscr, 72, sequence_lines(state)[:1], footer="Press any key to continue")


def draw_continue_message(stdscr: curses.window, state: GameState) -> None:
    centered_window(stdscr, 72, continue_message_lines(state)[:1], footer="Press any key to continue")


def draw_inventory(stdscr: curses.window, state: GameState) -> None:
    centered_window(stdscr, 72, inventory_lines(state))


def draw_use_scope(stdscr: curses.window, state: GameState) -> None:
    centered_window(stdscr, 72, use_scope_lines(state))


def draw_use_targets(stdscr: curses.window, world: StoryWorld, state: GameState) -> None:
    centered_window(stdscr, 72, use_targets_lines(world, state))


def handle_game_key(
    input_surface: Any,
    world: StoryWorld,
    data_path: Path,
    editor_enabled: bool,
    state: GameState,
    key: int,
) -> tuple[StoryWorld, GameState, bool]:
    system = world.system_by_id(state.system_id)

    if not state.editor_enabled or key not in (ord("a"), ord("A")):
        state.message = ""

    if state.editor_enabled and key in (ord("r"), ord("R")):
        try:
            world = reload_world_preserving_state(world, data_path, state)
            state.message = f"Reloaded: {data_path}"
        except (OSError, ValueError, KeyError) as error:
            state.message = f"Reload failed: {error}"
        return world, state, False

    if state.continue_message:
        state.continue_message = ""
        apply_outcomes(state, state.continue_on_complete)
        state.continue_on_complete = ()
        return world, state, False

    if sequence_active(state):
        advance_sequence(state)
        return world, state, False

    if state.view == "main_menu":
        if key == ord("1"):
            state.view = state.menu_return_view or "system"
            clear_notice(state)
        elif key == ord("2"):
            last_save_path = state.last_save_path
            state = initial_game_state(world, editor_enabled)
            state.last_save_path = last_save_path
            state.view = "system"
        elif key == ord("3"):
            default_path = state.last_save_path or str(default_save_path(data_path))
            requested = prompt_text(input_surface, "Save Game", "Filename:", default=default_path, max_length=160)
            if requested:
                try:
                    save_path = resolve_save_path(requested, data_path)
                    write_save_game(save_path, state)
                    state.last_save_path = str(save_path)
                    state.message = f"Saved: {save_path}"
                except (OSError, ValueError) as error:
                    state.message = f"Save failed: {error}"
        elif key == ord("4"):
            default_path = state.last_save_path or str(default_save_path(data_path))
            requested = prompt_text(input_surface, "Restore Game", "Filename:", default=default_path, max_length=160)
            if requested:
                try:
                    save_path = resolve_save_path(requested, data_path)
                    restored = restore_game_state(world, read_save_game(save_path), editor_enabled)
                    restored.last_save_path = str(save_path)
                    restored.message = f"Restored: {save_path}"
                    state = restored
                except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
                    state.message = f"Restore failed: {error}"
        elif key == ord("5"):
            return world, state, True
        return world, state, False

    if key in (ord("q"), ord("Q")):
        state.menu_return_view = state.view
        state.view = "main_menu"
        clear_notice(state)
        return world, state, False

    if state.view != "inventory" and key in (ord("i"), ord("I")):
        state.inventory_return_view = state.view
        state.view = "inventory"
        state.interaction_index = None
        clear_notice(state)
        return world, state, False

    if state.view == "use_scope":
        handle_use_scope_input(state, key)
        return world, state, False

    if state.view in {"use_room_target", "use_inventory_target"}:
        handle_use_target_input(world, state, key)
        return world, state, False

    if state.view == "inventory":
        handle_inventory_input(state, key)
        return world, state, False

    if state.view == "map":
        if key in (ord("g"), ord("G")):
            state.view = state.map_return_view
        return world, state, False

    if state.view == "jump":
        hops = sorted_hops(world, system)
        index = key - ord("1")
        if 0 <= index < len(hops):
            result = jump_boarded_ship_to_system(state, hops[index])
            if result is not None and result.status == "failed":
                state.message = f"Action failed: {result.error}"
                return world, state, False
            if result is not None and result.status == "blocked":
                start_action_messages(state, result)
                return world, state, False
        elif key in (ord("g"), ord("G")):
            state.view = "system"
        elif key in (ord("m"), ord("M")):
            state.map_return_view = "jump"
            state.view = "map"
        elif state.editor_enabled and key in (ord("a"), ord("A")):
            added = prompt_add_system(input_surface, world, data_path, state.system_id)
            if added is not None:
                world, state.message = added
        return world, state, False

    if state.destination_path:
        orbital = orbital_by_id(system, state.orbital_id)
        selected_destination = destination_at_path(orbital, state.destination_path)
        if selected_destination is None:
            state.destination_path.clear()
            state.interaction_index = None
            clear_notice(state)
            return world, state, False
        if boarded_ship_at_destination(state, selected_destination):
            ship = boarded_ship(state)
            ship_choices = ship_object_choices(state, ship)
            index = key - ord("1")
            if 0 <= index < len(ship_choices):
                handle_interaction_choice(state, ship_choices[index], index)
            elif key in (ord("t"), ord("T")) and ship is not None and ship_controlled_by_player(state, ship):
                take_off_from_destination(state)
            elif key in (ord("f"), ord("F")) and ship is not None and can_refuel_boarded_ship(state, selected_destination, ship):
                refuel_boarded_ship(state, selected_destination)
            elif key in (ord("g"), ord("G")):
                state.boarded_ship_id = None
            return world, state, False
        index = key - ord("1")
        interaction_choices = destination_interaction_choices(state, selected_destination)
        visible_destination_entries_list = visible_destination_entries(state, selected_destination)
        if 0 <= index < len(interaction_choices):
            handle_interaction_choice(state, interaction_choices[index], index)
        elif 0 <= index - len(interaction_choices) < len(visible_destination_entries_list):
            child_index, child_destination = visible_destination_entries_list[index - len(interaction_choices)]
            result = attempt_enter_destination_action(state, child_destination)
            if result is not None and result.status == "failed":
                state.message = f"Action failed: {result.error}"
            elif result is not None and result.status == "blocked":
                start_action_messages(state, result)
            else:
                state.destination_path.append(child_index)
        elif key in (ord("b"), ord("B")):
            board_ship_at_destination(state, selected_destination)
        elif key in (ord("g"), ord("G")):
            if state.destination_path != state.docked_path:
                state.destination_path.pop()
        elif state.editor_enabled and key in (ord("a"), ord("A")):
            added = prompt_add_inside_destination(input_surface, world, data_path, state.system_id, state.orbital_id, state.destination_path)
            if added is not None:
                world, state.message = added
        elif state.editor_enabled and key in (ord("d"), ord("D")):
            deleted = prompt_delete_detail(input_surface, world, data_path, state.system_id, state.orbital_id, state.destination_path, selected_destination)
            if deleted is not None:
                world, state.message = deleted
        elif state.editor_enabled and key in (ord("e"), ord("E")):
            edited = prompt_edit_landing_destination(
                input_surface,
                world,
                data_path,
                state.system_id,
                state.orbital_id,
                state.destination_path,
                selected_destination,
            )
            if edited is not None:
                world, state.message = edited
        return world, state, False

    if state.orbital_id is None:
        index = key - ord("1")
        if 0 <= index < len(system.orbitals):
            state.orbital_id = system.orbitals[index].id
            state.docked_path.clear()
            state.destination_path.clear()
            state.interaction_index = None
            clear_notice(state)
        elif state.editor_enabled and key in (ord("a"), ord("A")):
            added = prompt_add_orbital(input_surface, world, data_path, state.system_id)
            if added is not None:
                world, state.message = added
        elif state.editor_enabled and key in (ord("d"), ord("D")):
            deleted = prompt_delete_orbital(input_surface, world, data_path, state.system_id)
            if deleted is not None:
                world, state.message = deleted
                state.last_orbital_by_system.pop(state.system_id, None)
        elif state.editor_enabled and key in (ord("e"), ord("E")):
            edited = prompt_edit_system(input_surface, world, data_path, state.system_id)
            if edited is not None:
                world, state.message = edited
        elif key in (ord("l"), ord("L")):
            state.view = "jump"
        elif key in (ord("m"), ord("M")):
            state.map_return_view = "system"
            state.view = "map"
        return world, state, False

    if key in (ord("l"), ord("L")):
        orbital = orbital_by_id(system, state.orbital_id)
        if state.editor_enabled and not orbital.landing_options:
            added = prompt_add_landing_destination(input_surface, world, data_path, state.system_id, state.orbital_id, [])
            if added is not None:
                world, state.message = added
                orbital = orbital_by_id(world.system_by_id(state.system_id), state.orbital_id)
        landing_path = landing_path_for_orbital(state, orbital)
        if landing_path:
            state.docked_path = landing_path
            state.destination_path = list(landing_path)
            land_boarded_ship(state, orbital, landing_path)
            state.interaction_index = None
            clear_notice(state)
    elif state.editor_enabled and key in (ord("e"), ord("E")):
        edited = prompt_edit_orbital(input_surface, world, data_path, state.system_id, state.orbital_id)
        if edited is not None:
            world, state.message = edited
    elif key in (ord("t"), ord("T"), 27):
        state.orbital_id = None
        state.docked_path.clear()
        state.destination_path.clear()
        state.interaction_index = None
        clear_notice(state)

    return world, state, False


def run_curses(stdscr: curses.window, world: StoryWorld, data_path: Path, editor_enabled: bool = False) -> None:
    curses.curs_set(0)
    curses.use_default_colors()
    curses.init_pair(1, curses.COLOR_WHITE, curses.COLOR_BLACK)
    stdscr.keypad(True)
    state = initial_game_state(world, editor_enabled)

    while True:
        stdscr.erase()
        state.editor_box_top = None
        system = world.system_by_id(state.system_id)

        if state.continue_message:
            draw_continue_message(stdscr, state)
        elif sequence_active(state):
            draw_sequence(stdscr, state)
        elif state.view == "main_menu":
            draw_main_menu(stdscr, state)
        elif state.view == "use_scope":
            draw_use_scope(stdscr, state)
        elif state.view in {"use_room_target", "use_inventory_target"}:
            draw_use_targets(stdscr, world, state)
        elif state.view == "inventory":
            draw_inventory(stdscr, state)
        elif state.view == "jump":
            draw_jump_list(stdscr, world, state, system)
        elif state.view == "map":
            draw_map(stdscr, world, state, system)
        elif state.orbital_id is None:
            draw_system(stdscr, world, state, system)
        else:
            orbital = orbital_by_id(system, state.orbital_id)
            selected_destination = destination_at_path(orbital, state.destination_path)
            if selected_destination is not None:
                state.current_location_id = selected_destination.id
                enter_destination(state, selected_destination)
            if sequence_active(state):
                draw_sequence(stdscr, state)
            elif selected_destination is not None and boarded_ship_at_destination(state, selected_destination):
                draw_boarded_ship(stdscr, state, selected_destination)
            elif selected_destination is not None:
                draw_option(stdscr, state, orbital, selected_destination)
            else:
                draw_orbit(stdscr, state, orbital)

        if not state.continue_message and not sequence_active(state):
            draw_editor_box(stdscr, state)
        stdscr.refresh()
        key = stdscr.getch()
        world, state, should_quit = handle_game_key(stdscr, world, data_path, editor_enabled, state, key)
        if should_quit:
            return


def run_cli(world: StoryWorld, data_path: Path, editor_enabled: bool = False) -> None:
    prompter = CliPrompter()
    state = initial_game_state(world, editor_enabled)
    state.view = "system"

    while True:
        lines = adventure_screen_lines(world, state)
        append_gameplay_screen(state, lines)
        completions = coauthor_command_words() if state.coauthor_mode else command_words_for_state(world, state)
        render_cli_lines(lines)
        command = prompter.read_command(
            completions,
            prompt_text=coauthor_prompt_text() if state.coauthor_mode else command_prompt_text(),
            allow_blank_tab_toggle=editor_enabled,
        )
        if command is None:
            return
        if command != CLI_TOGGLE_COAUTHOR and not state.coauthor_mode:
            append_gameplay_entry(state, "Player", command)
        world, state, should_quit = handle_cli_command(prompter, world, data_path, editor_enabled, state, command)
        if should_quit:
            return


def run_generic_cli(definition: Any, data_path: Path) -> None:
    prompter = CliPrompter()
    state = initial_generic_cli_state(definition)

    while True:
        lines = generic_cli_screen_lines(state)
        completions = generic_command_words_for_state(state)
        render_cli_lines(lines)
        command = prompter.read_command(completions)
        if command is None:
            return
        state, should_quit = handle_generic_cli_command(state, command, data_path)
        if should_quit:
            return


def render_cli_lines(lines: list[str]) -> None:
    if not lines:
        return
    width, _height = terminal_dimensions()
    title_line = 0 if len(lines) > 1 and lines[1] == "" else None
    styled = cli_style_enabled()
    print()
    for index, line in enumerate(lines):
        line_color = coauthor_line_color(line) if styled else None
        for wrapped in wrap_lines([line], width):
            if line_color is not None:
                wrapped = color_cli_text(wrapped, line_color)
            elif styled and index == title_line:
                wrapped = bright_cli_text(wrapped)
            elif styled:
                wrapped = style_generic_name_list(wrapped)
            print(wrapped)


def render_cli_screen(world: StoryWorld, state: GameState) -> None:
    lines = adventure_screen_lines(world, state)
    render_cli_lines(lines)


def render_generic_cli_screen(state: GenericCliState) -> None:
    lines = generic_cli_screen_lines(state)
    render_cli_lines(lines)


def generic_cli_screen_lines(state: GenericCliState) -> list[str]:
    view = generic_cli_view(state)
    if state.pending_messages:
        state.message = combine_message_texts([state.message, *state.pending_messages])
        state.pending_messages = ()
        state.pending_index = 0

    location_changed = state.last_cli_location_id != view.location.id
    forced_location = state.force_cli_location
    show_location = forced_location or location_changed
    brief_revisit = show_location and view.location.id in state.seen_cli_location_ids and not forced_location
    lines: list[str] = []
    if show_location:
        lines.append(view.location.name)
    if show_location and not brief_revisit and view.location.description:
        lines.extend(["", view.location.description])
    if state.message:
        if lines:
            lines.append("")
        append_text_block(lines, state.message)
    if show_location and view.go_targets:
        lines.extend(["", f"You can go to {format_name_list([target.name for target in view.go_targets])}."])
    if show_location and view.people:
        lines.extend(["", f"You can see {format_name_list([person.name for person in view.people])}."])

    unnamed_visible: list[str] = []
    if show_location:
        for thing in view.things:
            if not brief_revisit and thing.description:
                lines.extend(["", thing.description])
            else:
                unnamed_visible.append(thing.name)
    if show_location and unnamed_visible:
        lines.extend(["", f"You can see {format_name_list(unnamed_visible)}."])
    if show_location and view.inventory:
        lines.extend(["", f"You are carrying {format_name_list([item.name for item in view.inventory])}."])
    state.last_cli_location_id = view.location.id
    if show_location:
        state.seen_cli_location_ids.add(view.location.id)
    state.force_cli_location = False
    return lines


def generic_command_words_for_state(state: GenericCliState) -> list[str]:
    words = [
        "look",
        "inventory",
        "inv",
        "save",
        "restore",
        "load",
        "restart",
        "quit",
        "exit",
        "go",
        "enter",
        "examine",
        "look at",
        "take",
        "get",
        "talk",
        "talk to",
        "use",
        "use on",
        "equip",
        "board",
        "power up",
    ]
    view = generic_cli_view(state)
    for entity in [view.location, *view.go_targets, *view.people, *view.things, *view.inventory]:
        words.append(entity.name)
    for action in view.actions:
        words.extend(generic_action_aliases(action))
    return words


def handle_generic_cli_command(state: GenericCliState, command: str, data_path: Path) -> tuple[GenericCliState, bool]:
    normalized = normalize_command(command)
    if normalized in {"quit", "exit"}:
        return state, True
    if normalized_matches_verb(normalized, "save"):
        save_generic_cli_game(data_path, state, command)
        return state, False
    if normalized_matches_verb(normalized, "restore") or normalized_matches_verb(normalized, "load"):
        return restore_generic_cli_game(data_path, state, command), False
    if normalized == "restart":
        last_save_path = state.last_save_path
        state = initial_generic_cli_state(state.definition)
        state.last_save_path = last_save_path
        state.message = "Restarted."
        return state, False
    if not normalized or normalized in {"look", "l", "continue"}:
        state.message = ""
        state.force_cli_location = True
        return state, False
    if normalized in {"inventory", "inv", "i"}:
        items = generic_cli_view(state).inventory
        state.message = "Inventory: " + format_name_list([item.name for item in items]) + "." if items else "Inventory: empty."
        return state, False

    action, error = find_generic_cli_action(command, generic_cli_view(state).actions)
    if error:
        state.message = error
    elif action is None:
        state.message = f"Unknown command: {command.strip()}"
    else:
        apply_generic_cli_action(state, action)
    return state, False


def advance_generic_cli_messages(state: GenericCliState) -> None:
    if not state.pending_messages:
        return
    if state.pending_index < len(state.pending_messages) - 1:
        state.pending_index += 1
        return
    state.pending_messages = ()
    state.pending_index = 0
    state.message = ""


def find_generic_cli_action(command: str, actions: tuple[GenericCliActionView, ...]) -> tuple[GenericCliActionView | None, str | None]:
    normalized = normalize_command(command)
    exact = [action for action in actions if normalized in {normalize_command(alias) for alias in generic_action_aliases(action)}]
    if len(exact) == 1:
        return exact[0], None
    if len(exact) > 1:
        return None, ambiguous_generic_cli_action_message(exact)
    prefix = [
        action
        for action in actions
        if any(normalize_command(alias).startswith(normalized) for alias in generic_action_aliases(action))
    ]
    if len(prefix) == 1:
        return prefix[0], None
    if len(prefix) > 1:
        return None, ambiguous_generic_cli_action_message(prefix)
    return None, None


def ambiguous_generic_cli_action_message(actions: Iterable[GenericCliActionView]) -> str:
    commands = sorted({action.command for action in actions})
    return "Ambiguous: " + format_name_list(commands) + "."


def generic_action_aliases(action: GenericCliActionView) -> tuple[str, ...]:
    aliases = [action.command]
    normalized = normalize_command(action.command)
    for source, replacements in {
        "examine ": ("look at ", "x "),
        "go ": ("enter ",),
        "take ": ("get ",),
    }.items():
        if normalized.startswith(source):
            target = action.command[len(source) :]
            aliases.extend(f"{replacement}{target}" for replacement in replacements)
    return tuple(aliases)


def apply_generic_cli_action(state: GenericCliState, action: GenericCliActionView) -> None:
    result = state.engine.attempt(state.runtime_state, ActionAttempt(action.action_id, action.args))
    if result.status == "failed":
        state.message = f"Action failed: {result.error}"
        return
    if result.status == "rejected":
        state.message = "That does not work."
        return

    messages = action_texts(result)
    state.pending_messages = ()
    state.pending_index = 0
    state.message = combine_message_texts(messages)


def adventure_location_key(world: StoryWorld, state: GameState) -> str:
    system = world.system_by_id(state.system_id)
    orbital = current_orbital(world, state)
    destination = current_destination(world, state)
    if destination is not None:
        if boarded_ship_at_destination(state, destination):
            ship = boarded_ship(state)
            ship_id = ship.id if ship is not None else state.boarded_ship_id or "unknown"
            return f"ship:{ship_id}"
        return f"destination:{destination.id}"
    if orbital is not None:
        return f"orbital:{orbital.id}"
    return f"system:{system.id}"


def consume_cli_modal_messages(state: GameState) -> tuple[str, ...]:
    messages: list[str] = []
    if state.continue_message:
        messages.append(state.continue_message)
        state.continue_message = ""
        apply_outcomes(state, state.continue_on_complete)
        state.continue_on_complete = ()
    while sequence_active(state):
        messages.append(state.sequence_messages[state.sequence_index])
        advance_sequence(state)
    return tuple(messages)


def append_cli_modal_messages_to_notice(state: GameState) -> None:
    messages = consume_cli_modal_messages(state)
    if messages:
        state.message = combine_message_texts([state.message, *messages])


def adventure_notice_lines(state: GameState) -> list[str]:
    lines: list[str] = []
    if state.message:
        append_text_block(lines, state.message)
    return lines


def adventure_screen_lines(world: StoryWorld, state: GameState) -> list[str]:
    append_cli_modal_messages_to_notice(state)

    state.view = "system"
    system = world.system_by_id(state.system_id)
    orbital = current_orbital(world, state)
    destination = current_destination(world, state)
    location_key = adventure_location_key(world, state)
    location_changed = state.last_cli_location_id != location_key
    forced_location = state.force_cli_location
    show_location = forced_location or location_changed
    brief_revisit = show_location and location_key in state.seen_cli_location_ids and not forced_location
    state.last_cli_location_id = location_key
    if show_location:
        state.seen_cli_location_ids.add(location_key)
    state.force_cli_location = False

    if not show_location:
        return adventure_notice_lines(state)

    if destination is not None:
        state.current_location_id = destination.id
        enter_destination(state, destination)
        append_cli_modal_messages_to_notice(state)
        if boarded_ship_at_destination(state, destination):
            return adventure_boarded_ship_lines(state, destination, brief=brief_revisit)
        return adventure_destination_lines(state, orbital, destination, brief=brief_revisit)
    if orbital is not None:
        return adventure_orbital_lines(world, state, system, orbital, brief=brief_revisit)
    return adventure_system_lines(world, state, system, brief=brief_revisit)


def adventure_system_lines(world: StoryWorld, state: GameState, system: System, brief: bool = False) -> list[str]:
    lines = [
        system.name,
    ]
    if not brief:
        lines.extend(
            [
                "",
                system.description,
                f"Star: {system.star_type}. Sol offset: {format_signed_au(system.position_au[0])}, {format_signed_au(system.position_au[1])}.",
            ]
        )
    append_notice(lines, state)
    if system.orbitals:
        append_visible_names(lines, "Destinations", [orbital.name for orbital in system.orbitals])
    if system.hops:
        append_visible_names(lines, "Jump points", [world.system_by_id(hop_id).name for hop_id in system.hops])
    append_inventory_summary(lines, state)
    return lines


def adventure_orbital_lines(world: StoryWorld, state: GameState, system: System, orbital: Orbital, brief: bool = False) -> list[str]:
    lines = [
        destination_status(orbital),
    ]
    if not brief:
        lines.extend(["", orbital.description])
    append_notice(lines, state)
    ship = boarded_ship(state)
    if ship is not None:
        lines.extend(["", f"Aboard: {ship.name}."])
        status = ship_status_lines(state, ship)
        if status:
            lines.extend(status)
    visible_landings = [destination.name for destination in orbital.landing_options if destination_visible(state, destination)]
    append_visible_names(lines, "Locations", visible_landings)
    if system.hops:
        append_visible_names(lines, "Jump points", [world.system_by_id(hop_id).name for hop_id in system.hops])
    append_inventory_summary(lines, state)
    return lines


def adventure_destination_lines(
    state: GameState,
    orbital: Orbital | None,
    destination: LandingOption,
    brief: bool = False,
) -> list[str]:
    title = f"{orbital.name}: {destination.name}" if orbital is not None else destination.name
    lines = [
        title,
    ]
    if not brief:
        lines.extend(["", destination.description])
    append_notice(lines, state)
    objects = visible_objects_for_destination(state, destination)
    if objects:
        append_visible_names(lines, "You see", [story_object.name for story_object in objects])
    npcs = visible_npcs_for_destination(state, destination)
    if npcs:
        lines.append("")
        for npc in npcs:
            lines.append(f"{npc.name}: {npc.description}")
    ships = visible_ships_for_destination(state, destination)
    if ships:
        lines.append("")
        for ship in ships:
            lines.append(ship_tagline(state, destination, ship))
    exits = [child.name for _index, child in visible_destination_entries(state, destination)]
    if orbital is not None:
        for _path, path_destination in linked_destination_entries(state, orbital, destination):
            if path_destination.name not in exits:
                exits.append(path_destination.name)
    if exits:
        append_visible_names(lines, "Exits", exits)
    append_inventory_summary(lines, state)
    return lines


def adventure_boarded_ship_lines(state: GameState, destination: LandingOption | None, brief: bool = False) -> list[str]:
    ship = boarded_ship(state)
    name = ship.name if ship is not None else "Ship"
    lines = [
        f"Aboard the {name}",
        "",
    ]
    status = ship_status_lines(state, ship)
    if status:
        lines.extend(status)
        lines.append("")
    description = ship_interior_description(state, ship)
    if description and not brief:
        lines.append(description)
    append_notice(lines, state)
    objects = visible_objects_for_ship(state, ship)
    if objects:
        append_visible_names(lines, "You see", [story_object.name for story_object in objects])
    if destination is not None:
        lines.extend(["", f"Outside: {destination.name}."])
    append_inventory_summary(lines, state)
    return lines


def append_notice(lines: list[str], state: GameState) -> None:
    if state.message:
        lines.extend(["", state.message])


def append_visible_names(lines: list[str], title: str, names: list[str]) -> None:
    if not names:
        return
    lines.extend(["", f"{title}: {format_name_list(names)}."])


def append_inventory_summary(lines: list[str], state: GameState) -> None:
    items = [item.name for item in inventory_items(state)]
    if items:
        append_visible_names(lines, "Inventory", items)


def format_name_list(names: list[str]) -> str:
    if len(names) <= 2:
        return " and ".join(names)
    return ", ".join(names[:-1]) + f", and {names[-1]}"


def current_orbital(world: StoryWorld, state: GameState) -> Orbital | None:
    if state.orbital_id is None:
        return None
    try:
        return orbital_by_id(world.system_by_id(state.system_id), state.orbital_id)
    except KeyError:
        return None


def current_destination(world: StoryWorld, state: GameState) -> LandingOption | None:
    orbital = current_orbital(world, state)
    if orbital is None:
        return None
    return destination_at_path(orbital, state.destination_path)


def linked_destination_entries(state: GameState, orbital: Orbital, destination: LandingOption) -> list[tuple[list[int], LandingOption]]:
    entries: list[tuple[list[int], LandingOption]] = []
    for target_id in destination.paths:
        path = destination_path_for_id(orbital, target_id)
        if path is None:
            continue
        target = destination_at_path(orbital, path)
        if target is not None and destination_visible(state, target):
            entries.append((path, target))
    return entries


def destination_path_for_id(orbital: Orbital, destination_id: str) -> list[int] | None:
    for index, destination in enumerate(orbital.landing_options):
        path = destination_path_for_id_in_destination(destination, destination_id, [index])
        if path is not None:
            return path
    return None


def destination_path_for_id_in_destination(
    destination: LandingOption,
    destination_id: str,
    current_path: list[int],
) -> list[int] | None:
    if destination.id == destination_id:
        return current_path
    for index, child in enumerate(destination.destinations):
        path = destination_path_for_id_in_destination(child, destination_id, [*current_path, index])
        if path is not None:
            return path
    return None


GENERIC_CLI_REQUIRED_TRAITS = {
    "Presentable": ("name", "description"),
    "Actor": (),
    "Location": (),
    "Relocatable": (),
}
GENERIC_CLI_REQUIRED_RELATIONS = {
    "At": ("subject", "location"),
    "CanSee": ("actor", "target"),
}
GENERIC_CLI_REQUIRED_ACTIONS = {
    "Enter": ("actor", "destination"),
    "Examine": ("actor", "target"),
}


def validate_generic_cli_contract(definition: Any) -> None:
    errors: list[str] = []
    for trait_id, field_ids in GENERIC_CLI_REQUIRED_TRAITS.items():
        trait = definition.traits.get(trait_id)
        if trait is None:
            errors.append(f"missing trait {trait_id}")
            continue
        known_fields = {field.id for field in trait.fields}
        for field_id in field_ids:
            if field_id not in known_fields:
                errors.append(f"trait {trait_id} must define field {field_id}")
    for relation_id, param_ids in GENERIC_CLI_REQUIRED_RELATIONS.items():
        relation = definition.relations.get(relation_id)
        if relation is None:
            errors.append(f"missing relation {relation_id}({', '.join(param_ids)})")
            continue
        actual = tuple(param.id for param in relation.parameters)
        if actual != param_ids:
            errors.append(f"relation {relation_id} must have params ({', '.join(param_ids)})")
    for action_id, param_ids in GENERIC_CLI_REQUIRED_ACTIONS.items():
        action = definition.actions.get(action_id)
        if action is None:
            errors.append(f"missing action {action_id}({', '.join(param_ids)})")
            continue
        actual = tuple(param.id for param in action.parameters)
        if actual != param_ids:
            errors.append(f"action {action_id} must have params ({', '.join(param_ids)})")
    if errors:
        raise GenericCliContractError("Generic CLI requires core prelude support: " + "; ".join(errors))


def initial_generic_cli_state(definition: Any) -> GenericCliState:
    validate_generic_cli_contract(definition)
    runtime_state = definition.instantiate()
    actor_id = generic_cli_actor_id(definition, runtime_state)
    start_location = definition.metadata.get("start", {}).get("location")
    if isinstance(start_location, str) and start_location in runtime_state.entities:
        runtime_state.assert_relation("At", [actor_id, start_location])
    if generic_cli_current_location_id(runtime_state, actor_id) is None:
        raise GenericCliContractError(f"Generic CLI could not find current location for actor {actor_id}")
    return GenericCliState(
        definition=definition,
        runtime_state=runtime_state,
        engine=RulesEngine(definition),
        actor_id=actor_id,
    )


def generic_cli_actor_id(definition: Any, runtime_state: WorldState) -> str:
    actor_id = definition.metadata.get("start", {}).get("actor")
    if isinstance(actor_id, str) and actor_id in runtime_state.entities and runtime_state.has_trait(actor_id, "Actor"):
        return actor_id
    actors = [entity_id for entity_id in runtime_state.entities if runtime_state.has_trait(entity_id, "Actor")]
    if len(actors) == 1:
        return actors[0]
    if isinstance(actor_id, str):
        raise GenericCliContractError(f"Generic CLI start.actor {actor_id!r} must reference an Actor entity")
    raise GenericCliContractError("Generic CLI requires story.start.actor or exactly one Actor entity")


def generic_cli_current_location_id(runtime_state: WorldState, actor_id: str) -> str | None:
    for entity_id in runtime_state.entities:
        if entity_id == actor_id or not runtime_state.has_trait(entity_id, "Location"):
            continue
        if generic_relation_true(runtime_state, "At", [actor_id, entity_id]):
            return entity_id
    return None


def generic_cli_view(state: GenericCliState) -> GenericCliView:
    location_id = generic_cli_current_location_id(state.runtime_state, state.actor_id)
    if location_id is None:
        raise GenericCliContractError(f"Generic CLI could not find current location for actor {state.actor_id}")
    visible = [
        entity_id
        for entity_id in state.runtime_state.entities
        if entity_id != state.actor_id
        and entity_id != location_id
        and state.runtime_state.has_trait(entity_id, "Presentable")
        and state.runtime_state.has_trait(entity_id, "Relocatable")
        and generic_relation_true(state.runtime_state, "CanSee", [state.actor_id, entity_id])
    ]
    inventory = [
        entity_id
        for entity_id in state.runtime_state.entities
        if entity_id != state.actor_id
        and state.runtime_state.has_trait(entity_id, "Presentable")
        and generic_relation_true(state.runtime_state, "CarriedBy", [state.actor_id, entity_id])
    ]
    visible_set = set(visible)
    inventory_set = set(inventory)
    child_go_targets = [
        generic_entity_view(state.runtime_state, entity_id)
        for entity_id in visible
        if state.runtime_state.has_trait(entity_id, "Location")
        and not state.runtime_state.has_trait(entity_id, "Boardable")
        and generic_action_available(state, "Enter", {"actor": state.actor_id, "destination": entity_id})
    ]
    path_go_targets = [
        view
        for view in generic_path_target_views(state.runtime_state, location_id)
        if generic_action_available(state, "Enter", {"actor": state.actor_id, "destination": view.id})
    ]
    go_targets = tuple(dedupe_entity_views([*child_go_targets, *path_go_targets]))
    people = tuple(
        generic_entity_view(state.runtime_state, entity_id)
        for entity_id in visible
        if state.runtime_state.has_trait(entity_id, "Actor")
    )
    things = tuple(
        generic_entity_view(state.runtime_state, entity_id)
        for entity_id in visible
        if entity_id not in {view.id for view in go_targets}
        and entity_id not in {view.id for view in people}
    )
    inventory_views = tuple(generic_entity_view(state.runtime_state, entity_id) for entity_id in inventory)
    return GenericCliView(
        actor_id=state.actor_id,
        location=generic_entity_view(state.runtime_state, location_id),
        go_targets=go_targets,
        people=people,
        things=things,
        inventory=inventory_views,
        actions=tuple(generic_cli_actions(state, visible_set | {view.id for view in go_targets}, inventory_set)),
    )


def generic_path_target_views(runtime_state: WorldState, location_id: str) -> list[GenericCliEntityView]:
    if "Path" not in runtime_state.definition.relations:
        return []
    return [
        generic_entity_view(runtime_state, entity_id)
        for entity_id in runtime_state.entities
        if entity_id != location_id
        and runtime_state.has_trait(entity_id, "Presentable")
        and runtime_state.has_trait(entity_id, "Location")
        and not runtime_state.has_trait(entity_id, "Boardable")
        and generic_relation_true(runtime_state, "Path", [location_id, entity_id])
    ]


def dedupe_entity_views(views: Iterable[GenericCliEntityView]) -> list[GenericCliEntityView]:
    deduped: list[GenericCliEntityView] = []
    seen: set[str] = set()
    for view in views:
        if view.id in seen:
            continue
        seen.add(view.id)
        deduped.append(view)
    return deduped


def generic_cli_actions(state: GenericCliState, visible_ids: set[str], inventory_ids: set[str]) -> list[GenericCliActionView]:
    actions: list[GenericCliActionView] = []
    visible_and_inventory = list(dict.fromkeys([*visible_ids, *inventory_ids]))
    for entity_id in visible_and_inventory:
        view = generic_entity_view(state.runtime_state, entity_id)
        if generic_action_available(state, "Examine", {"actor": state.actor_id, "target": entity_id}):
            actions.append(GenericCliActionView(f"examine {view.name}", "Examine", {"actor": state.actor_id, "target": entity_id}, entity_id))
    for entity_id in visible_ids:
        view = generic_entity_view(state.runtime_state, entity_id)
        if state.runtime_state.has_trait(entity_id, "Location") and not state.runtime_state.has_trait(entity_id, "Boardable"):
            args = {"actor": state.actor_id, "destination": entity_id}
            if generic_action_available(state, "Enter", args):
                actions.append(GenericCliActionView(f"go {view.name}", "Enter", args, entity_id))
        if state.runtime_state.has_trait(entity_id, "Portable"):
            args = {"actor": state.actor_id, "item": entity_id}
            if generic_action_available(state, "Take", args):
                actions.append(GenericCliActionView(f"take {view.name}", "Take", args, entity_id))
        if state.runtime_state.has_trait(entity_id, "Social"):
            args = {"actor": state.actor_id, "target": entity_id}
            if generic_action_available(state, "Talk", args):
                actions.append(GenericCliActionView(f"talk to {view.name}", "Talk", args, entity_id))
        if state.runtime_state.has_trait(entity_id, "Boardable"):
            args = {"actor": state.actor_id, "ship": entity_id}
            if generic_action_available(state, "Board", args):
                actions.append(GenericCliActionView(f"board {view.name}", "Board", args, entity_id))
        args = {"actor": state.actor_id, "target": entity_id}
        if generic_action_available(state, "PowerUp", args):
            actions.append(GenericCliActionView(f"power up {view.name}", "PowerUp", args, entity_id))
    for entity_id in inventory_ids:
        view = generic_entity_view(state.runtime_state, entity_id)
        if state.runtime_state.has_trait(entity_id, "Equipment"):
            args = {"actor": state.actor_id, "item": entity_id}
            if generic_action_available(state, "Equip", args):
                actions.append(GenericCliActionView(f"equip {view.name}", "Equip", args, entity_id))
        if state.runtime_state.has_trait(entity_id, "Usable"):
            for target_id in visible_and_inventory:
                if target_id == entity_id:
                    continue
                target = generic_entity_view(state.runtime_state, target_id)
                args = {"actor": state.actor_id, "source": entity_id, "target": target_id}
                if generic_action_available(state, "Use", args):
                    actions.append(GenericCliActionView(f"use {view.name} on {target.name}", "Use", args, target_id))
    return actions


def generic_entity_view(runtime_state: WorldState, entity_id: str) -> GenericCliEntityView:
    fields = runtime_state.entity(entity_id).trait("Presentable").fields
    return GenericCliEntityView(
        id=entity_id,
        name=str(fields.get("name") or entity_id),
        description=str(fields.get("description") or ""),
        traits=frozenset(runtime_state.entity(entity_id).traits),
    )


def generic_action_available(state: GenericCliState, action_id: str, args: dict[str, Any]) -> bool:
    if action_id not in state.definition.actions:
        return False
    result = state.engine.attempt(state.runtime_state.clone(), ActionAttempt(action_id, args))
    return result.status not in {"rejected", "failed"}


def generic_relation_true(runtime_state: WorldState, relation: str, args: list[Any]) -> bool:
    if relation not in runtime_state.definition.relations:
        return False
    try:
        return bool(runtime_state.test(relation, args))
    except (KeyError, ValueError):
        return False


def command_words_for_state(world: StoryWorld, state: GameState) -> list[str]:
    words = [
        "look",
        "inventory",
        "save",
        "restore",
        "load",
        "restart",
        "quit",
        "exit",
        "go",
        "back",
        "go back",
        "examine",
        "look at",
        "take",
        "talk",
        "talk to",
        "use",
        "use on",
        "equip",
        "board",
        "disembark",
        "leave ship",
        "take off",
        "jump",
        "land",
        "refuel",
    ]
    targets = adventure_named_targets(world, state)
    words.extend(target.name for target in targets)
    for target in targets:
        words.extend(target.aliases)
    words.extend(adventure_command_phrases(world, state))
    if state.editor_enabled:
        for command in editor_commands_for_state(state):
            key, _sep, label = command.partition(":")
            words.append(key.lower())
            if label.strip():
                words.append(label.strip().lower())
        words.extend(["add", "delete", "edit", "reload", "prompt"])

    return words


def adventure_command_phrases(world: StoryWorld, state: GameState) -> list[str]:
    phrases: list[str] = []
    for target in navigation_targets(world, state):
        phrases.append(f"go {target.name}")
    for target in examine_targets(world, state):
        phrases.append(f"examine {target.name}")
        phrases.append(f"look at {target.name}")
    for target in take_targets(world, state):
        phrases.append(f"take {target.name}")
    for target in talk_targets(world, state):
        phrases.append(f"talk to {target.name}")
    for target in board_targets(world, state):
        phrases.append(f"board {target.name}")
    for target in jump_targets(world, state):
        phrases.append(f"jump {target.name}")
    for source in inventory_object_targets(state):
        for target in use_targets_for_prompt(world, state, source.value):
            phrases.append(f"use {source.name} on {target.name}")
    return phrases


def handle_cli_command(
    input_surface: Any,
    world: StoryWorld,
    data_path: Path,
    editor_enabled: bool,
    state: GameState,
    command: str,
) -> tuple[StoryWorld, GameState, bool]:
    append_cli_modal_messages_to_notice(state)
    normalized = normalize_command(command)
    if editor_enabled and command == CLI_TOGGLE_COAUTHOR:
        toggle_coauthor_mode(state)
        return world, state, False
    if normalized in {"quit", "exit"}:
        return world, state, True
    if editor_enabled and normalized == "prompt":
        toggle_coauthor_mode(state)
        return world, state, False
    if editor_enabled and state.coauthor_mode:
        if normalized in {"story", "exit coauthor", "exit prompt", "leave coauthor", "/story"}:
            state.coauthor_mode = False
            state.message = "Story mode."
            return world, state, False
        if not command.strip():
            state.message = "Coauthor mode. Type a request or press Tab on a blank prompt to return to the story."
            return world, state, False
        progress = CliCoauthorProgress()
        result = run_coauthor_editor_prompt(data_path, command, state, progress)
        state.message = format_coauthor_transcript(result, include_tools=False)
        if result.committed:
            try:
                world = reload_world_preserving_state(world, data_path, state)
            except (OSError, ValueError, KeyError) as error:
                state.message = combine_message_texts([state.message, f"Reload failed: {error}"])
        return world, state, False
    if normalized_matches_verb(normalized, "save"):
        save_cli_game(input_surface, data_path, state, command)
        return world, state, False
    if normalized_matches_verb(normalized, "restore") or normalized_matches_verb(normalized, "load"):
        state = restore_cli_game(input_surface, world, data_path, editor_enabled, state, command)
        return world, state, False
    if normalized == "restart":
        last_save_path = state.last_save_path
        state = initial_game_state(world, editor_enabled)
        state.last_save_path = last_save_path
        state.view = "system"
        state.message = "Restarted."
        return world, state, False
    if not normalized or normalized in {"look", "l", "continue"}:
        state.message = ""
        state.force_cli_location = True
        return world, state, False
    if normalized in {"inventory", "inv", "i"}:
        items = inventory_items(state)
        state.message = "Inventory: " + format_name_list([item.name for item in items]) + "." if items else "Inventory: empty."
        return world, state, False
    if editor_enabled and normalized == "reload":
        try:
            world = reload_world_preserving_state(world, data_path, state)
            state.message = f"Reloaded: {data_path}"
        except (OSError, ValueError, KeyError) as error:
            state.message = f"Reload failed: {error}"
        return world, state, False
    coauthor_prompt = coauthor_prompt_remainder(command) if editor_enabled else None
    if coauthor_prompt is not None:
        if not coauthor_prompt:
            if input_surface is None or not hasattr(input_surface, "prompt_multiline_text"):
                state.message = "Coauthor prompt is empty."
                return world, state, False
            coauthor_prompt = input_surface.prompt_multiline_text(
                "Coauthor",
                "Story change request",
                ["Describe the change to make to the current story model."],
            )
        if coauthor_prompt is None:
            state.message = "Coauthor cancelled."
            return world, state, False
        progress = CliCoauthorProgress()
        result = run_coauthor_editor_prompt(data_path, coauthor_prompt, state, progress)
        state.message = format_coauthor_transcript(result)
        if result.committed:
            try:
                world = reload_world_preserving_state(world, data_path, state)
            except (OSError, ValueError, KeyError) as error:
                state.message = combine_message_texts([state.message, f"Reload failed: {error}"])
        return world, state, False

    handled = handle_adventure_command(world, state, normalized)
    if not handled:
        state.message = f"Unknown command: {command.strip()}"
    return world, state, False


def toggle_coauthor_mode(state: GameState) -> None:
    state.coauthor_mode = not state.coauthor_mode
    if state.coauthor_mode:
        state.message = "Coauthor mode. Type normally to talk with the story editor; press Tab on a blank prompt to return."
    else:
        state.message = "Story mode."


def coauthor_prompt_remainder(command: str) -> str | None:
    colon_match = re.match(r"^\s*prompt\s*:\s*(.*)$", command, re.IGNORECASE | re.DOTALL)
    if colon_match:
        return colon_match.group(1).strip()
    word_match = re.match(r"^\s*prompt\s+(.+)$", command, re.IGNORECASE | re.DOTALL)
    if word_match:
        return word_match.group(1).strip()
    return None


def run_coauthor_editor_prompt(
    data_path: Path,
    prompt: str,
    state: GameState | None = None,
    progress: Any | None = None,
) -> Any:
    from qualms.coauthoring import CoauthorSession, run_coauthor_prompt

    session = None
    history = ""
    if state is not None:
        if state.coauthor_session is None:
            state.coauthor_session = CoauthorSession()
        session = state.coauthor_session
        history = gameplay_history_text(state)
    return run_coauthor_prompt(data_path, prompt, session=session, gameplay_history=history, progress=progress)


def format_coauthor_transcript(result: Any, include_tools: bool = True) -> str:
    lines = ["Coauthor:"]
    for event in getattr(result, "transcript", []):
        kind = getattr(event, "kind", "")
        name = getattr(event, "name", None)
        content = getattr(event, "content", "")
        if kind == "agent" and not content.startswith("Request:"):
            lines.append(f"Agent: {content}")
        elif include_tools and kind == "tool_call":
            lines.append(f"Tool call: {name or 'tool'} {content}".rstrip())
        elif include_tools and kind == "tool_result":
            lines.append(f"Tool result: {name or 'tool'} {content}".rstrip())
        elif include_tools and kind == "status":
            lines.append(f"Coauthor: {content}")
        elif kind == "error":
            lines.append(f"Coauthor error: {content}")
    output = getattr(result, "output", None)
    if output is not None:
        summary = getattr(output, "summary", "")
        if summary:
            lines.append(f"Summary: {summary}")
        feedback = getattr(output, "feedback", None)
        if feedback is not None:
            confusing = getattr(feedback, "confusing", "")
            tooling = getattr(feedback, "tooling", "")
            if confusing or tooling:
                lines.append(f"Feedback: confusing={confusing or 'none'} tooling={tooling or 'none'}")
    lines.append("Committed." if getattr(result, "committed", False) else "No changes committed.")
    return "\n".join(lines)


class CliCoauthorProgress:
    def __init__(self) -> None:
        self._streaming_agent = False

    def __call__(self, event: Any) -> None:
        kind = getattr(event, "kind", "")
        name = getattr(event, "name", None)
        content = getattr(event, "content", "")
        if kind == "agent" and content.startswith("Request:"):
            return
        if kind == "agent_delta":
            if not self._streaming_agent:
                print()
                self._write("Agent: ", CLI_CYAN)
                self._streaming_agent = True
            self._write(content, CLI_CYAN)
            return
        if self._streaming_agent:
            print()
            self._streaming_agent = False
        if kind == "status":
            self._line(f"Coauthor: {content}", CLI_CYAN)
        elif kind == "agent":
            self._line(f"Agent: {content}", CLI_CYAN)
        elif kind == "tool_call":
            self._line(f"Tool call: {name or 'tool'} {content}".rstrip(), CLI_GRAY)
        elif kind == "tool_result":
            self._line(f"Tool result: {name or 'tool'} {content}".rstrip(), CLI_GRAY)
        elif kind == "error":
            self._line(f"Coauthor error: {content}", CLI_CYAN)

    def _line(self, text: str, color: str) -> None:
        print(color_cli_text(text, color) if cli_style_enabled() else text)

    def _write(self, text: str, color: str) -> None:
        sys.stdout.write(color_cli_text(text, color) if cli_style_enabled() else text)
        sys.stdout.flush()


def save_cli_game(input_surface: Any, data_path: Path, state: GameState, command: str) -> None:
    requested = command_remainder(command, "save")
    if not requested:
        requested = state.last_save_path or str(default_save_path(data_path))
    try:
        save_path = resolve_save_path(requested, data_path)
        write_save_game(save_path, state)
        state.last_save_path = str(save_path)
        state.message = f"Saved: {save_path}"
    except (OSError, ValueError) as error:
        state.message = f"Save failed: {error}"


def save_generic_cli_game(data_path: Path, state: GenericCliState, command: str) -> None:
    requested = command_remainder(command, "save")
    if not requested:
        requested = state.last_save_path or str(default_save_path(data_path))
    try:
        save_path = resolve_save_path(requested, data_path)
        write_generic_save_game(save_path, state)
        state.last_save_path = str(save_path)
        state.message = f"Saved: {save_path}"
        state.pending_messages = ()
        state.pending_index = 0
    except (OSError, ValueError) as error:
        state.message = f"Save failed: {error}"


def restore_cli_game(
    input_surface: Any,
    world: StoryWorld,
    data_path: Path,
    editor_enabled: bool,
    state: GameState,
    command: str,
) -> GameState:
    requested = command_remainder(command, "restore") or command_remainder(command, "load")
    if not requested:
        requested = state.last_save_path or str(default_save_path(data_path))
    try:
        save_path = resolve_save_path(requested, data_path)
        restored = restore_game_state(world, read_save_game(save_path), editor_enabled)
        restored.last_save_path = str(save_path)
        restored.view = "system"
        restored.message = f"Restored: {save_path}"
        return restored
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        state.message = f"Restore failed: {error}"
        return state


def restore_generic_cli_game(data_path: Path, state: GenericCliState, command: str) -> GenericCliState:
    requested = command_remainder(command, "restore") or command_remainder(command, "load")
    if not requested:
        requested = state.last_save_path or str(default_save_path(data_path))
    try:
        save_path = resolve_save_path(requested, data_path)
        restored = restore_generic_cli_state(state.definition, read_generic_save_game(save_path))
        restored.last_save_path = str(save_path)
        restored.message = f"Restored: {save_path}"
        restored.pending_messages = ()
        restored.pending_index = 0
        return restored
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        state.message = f"Restore failed: {error}"
        return state


def command_remainder(command: str, verb: str) -> str:
    match = re.match(rf"^\s*{re.escape(verb)}(?:\s+(.+))?\s*$", command, re.IGNORECASE)
    if not match:
        return ""
    return (match.group(1) or "").strip()


def normalized_matches_verb(normalized: str, verb: str) -> bool:
    return normalized == verb or normalized.startswith(verb + " ")


def handle_adventure_command(world: StoryWorld, state: GameState, normalized: str) -> bool:
    if normalized in {"back", "go back", "out"}:
        go_back(world, state)
        return True
    if normalized in {"take off", "takeoff"}:
        take_off_from_destination(state)
        return True
    if normalized in {"disembark", "leave ship", "exit ship"}:
        state.boarded_ship_id = None
        clear_notice(state)
        return True
    if normalized == "refuel":
        destination = current_destination(world, state)
        if destination is not None:
            refuel_boarded_ship(state, destination)
        else:
            state.message = "There is nothing to refuel here."
        return True
    if normalized == "land":
        land_from_orbit(world, state, "")
        return True
    for verb in ("go to", "go", "enter"):
        remainder = normalized_removeprefix(normalized, verb)
        if remainder is not None:
            go_to_target(world, state, remainder)
            return True
    for verb in ("jump to", "jump"):
        remainder = normalized_removeprefix(normalized, verb)
        if remainder is not None:
            jump_to_target(world, state, remainder)
            return True
    for verb in ("land at", "land on"):
        remainder = normalized_removeprefix(normalized, verb)
        if remainder is not None:
            land_from_orbit(world, state, remainder)
            return True
    for verb in ("look at", "examine", "x"):
        remainder = normalized_removeprefix(normalized, verb)
        if remainder is not None:
            examine_target(world, state, remainder)
            return True
    for verb in ("take", "get"):
        remainder = normalized_removeprefix(normalized, verb)
        if remainder is not None:
            take_target(world, state, remainder)
            return True
    for verb in ("talk to", "talk"):
        remainder = normalized_removeprefix(normalized, verb)
        if remainder is not None:
            talk_to_target(world, state, remainder)
            return True
    for verb in ("board",):
        remainder = normalized_removeprefix(normalized, verb)
        if remainder is not None:
            board_target(world, state, remainder)
            return True
    for verb in ("equip", "wear"):
        remainder = normalized_removeprefix(normalized, verb)
        if remainder is not None:
            equip_target(state, remainder)
            return True
    remainder = normalized_removeprefix(normalized, "use")
    if remainder is not None:
        use_command(world, state, remainder)
        return True
    return False


def normalized_removeprefix(value: str, prefix: str) -> str | None:
    if value == prefix:
        return ""
    prefix_with_space = prefix + " "
    if value.startswith(prefix_with_space):
        return value[len(prefix_with_space) :].strip()
    return None


def go_back(world: StoryWorld, state: GameState) -> None:
    if state.boarded_ship_id is not None:
        state.boarded_ship_id = None
        clear_notice(state)
        return
    if state.destination_path and state.destination_path != state.docked_path:
        state.destination_path.pop()
        clear_notice(state)
        return
    if state.orbital_id is not None:
        state.orbital_id = None
        state.docked_path.clear()
        state.destination_path.clear()
        clear_notice(state)


def go_to_target(world: StoryWorld, state: GameState, target_name: str) -> None:
    if not target_name:
        state.message = "Go where?"
        return
    target, error = find_named_target(target_name, navigation_targets(world, state))
    if error:
        state.message = error
        return
    if target is None:
        state.message = f"You cannot go to {target_name}."
        return
    if target.kind == "orbital":
        orbital = target.value
        state.orbital_id = orbital.id
        state.docked_path.clear()
        state.destination_path.clear()
        clear_notice(state)
        return
    if target.kind == "landing":
        index, destination = target.value
        state.docked_path = [index]
        state.destination_path = [index]
        state.current_location_id = destination.id
        orbital = current_orbital(world, state)
        if orbital is not None:
            land_boarded_ship(state, orbital, [index])
        clear_notice(state)
        return
    if target.kind == "destination":
        index, destination = target.value
        result = attempt_enter_destination_action(state, destination)
        if result is not None and result.status == "failed":
            state.message = f"Action failed: {result.error}"
        elif result is not None and result.status == "blocked":
            start_action_messages(state, result)
        else:
            state.destination_path.append(index)
            state.current_location_id = destination.id
            clear_notice(state)
        return
    if target.kind == "path_destination":
        path, destination = target.value
        result = attempt_enter_destination_action(state, destination)
        if result is not None and result.status == "failed":
            state.message = f"Action failed: {result.error}"
        elif result is not None and result.status == "blocked":
            start_action_messages(state, result)
        else:
            state.destination_path = list(path)
            state.current_location_id = destination.id
            clear_notice(state)


def land_from_orbit(world: StoryWorld, state: GameState, target_name: str) -> None:
    orbital = current_orbital(world, state)
    if orbital is None:
        state.message = "There is nowhere to land from here."
        return
    if target_name:
        target, error = find_named_target(target_name, landing_targets(state, orbital))
        if error:
            state.message = error
            return
        if target is None:
            state.message = f"You cannot land at {target_name}."
            return
        landing_path = [target.value[0]]
    else:
        landing_path = landing_path_for_orbital(state, orbital)
    if not landing_path:
        state.message = "There is nowhere to land."
        return
    state.docked_path = list(landing_path)
    state.destination_path = list(landing_path)
    destination = destination_at_path(orbital, landing_path)
    if destination is not None:
        state.current_location_id = destination.id
    land_boarded_ship(state, orbital, list(landing_path))
    clear_notice(state)


def jump_to_target(world: StoryWorld, state: GameState, target_name: str) -> None:
    if not target_name:
        state.message = "Jump where?"
        return
    target, error = find_named_target(target_name, jump_targets(world, state))
    if error:
        state.message = error
        return
    if target is None:
        state.message = f"You cannot jump to {target_name}."
        return
    result = jump_boarded_ship_to_system(state, target.value)
    if result is not None and result.status == "failed":
        state.message = f"Action failed: {result.error}"
    elif result is not None and result.status == "blocked":
        start_action_messages(state, result)


def examine_target(world: StoryWorld, state: GameState, target_name: str) -> None:
    if not target_name:
        state.message = ""
        return
    target, error = find_named_target(target_name, examine_targets(world, state))
    if error:
        state.message = error
        return
    if target is None:
        state.message = f"You do not see {target_name}."
        return
    if target.kind == "destination":
        start_continue_message(state, target.value.description)
        return
    if target.kind == "inventory":
        handle_interaction_choice(state, InteractionChoice("object", target.value, "Examine"), 0)
        return
    if target.kind in {"object", "npc", "ship"}:
        interaction_kind = {"object": "object", "npc": "npc", "ship": "ship"}[target.kind]
        handle_interaction_choice(state, InteractionChoice(interaction_kind, target.value, "Examine"), 0)


def take_target(world: StoryWorld, state: GameState, target_name: str) -> None:
    target, error = find_named_target(target_name, take_targets(world, state))
    if error:
        state.message = error
        return
    if target is None:
        state.message = f"You cannot take {target_name}."
        return
    handle_interaction_choice(state, InteractionChoice("object", target.value, "Take"), 0)


def talk_to_target(world: StoryWorld, state: GameState, target_name: str) -> None:
    target, error = find_named_target(target_name, talk_targets(world, state))
    if error:
        state.message = error
        return
    if target is None:
        state.message = f"You cannot talk to {target_name}."
        return
    handle_interaction_choice(state, InteractionChoice("npc", target.value, "Talk"), 0)


def board_target(world: StoryWorld, state: GameState, target_name: str) -> None:
    targets = board_targets(world, state)
    if not target_name and len(targets) == 1:
        board_specific_ship(state, targets[0].value)
        return
    target, error = find_named_target(target_name, targets)
    if error:
        state.message = error
        return
    if target is None:
        state.message = f"You cannot board {target_name}."
        return
    board_specific_ship(state, target.value)


def board_specific_ship(state: GameState, ship: Ship) -> None:
    ship_entity_id = entity_id_for_local_id(state, ship.id)
    if ship_entity_id:
        result = attempt_rules_action(state, "Board", {"actor": "player", "ship": ship_entity_id})
        if result is not None and result.status == "failed":
            state.message = f"Action failed: {result.error}"
            return
        if result is not None and result.status == "blocked":
            start_action_messages(state, result)
            return
    state.boarded_ship_id = ship.id
    state.facts.add(f"ship:{ship.id}:visited")
    state.facts.add(f"ship:{ship.id}:identified")
    clear_notice(state)


def equip_target(state: GameState, target_name: str) -> None:
    target, error = find_named_target(target_name, inventory_object_targets(state))
    if error:
        state.message = error
        return
    if target is None:
        state.message = f"You do not have {target_name}."
        return
    item = target.value
    if not item.equipment_slot:
        state.message = "You cannot equip that."
        return
    entity_id = entity_id_for_local_id(state, item.id)
    if entity_id:
        result = attempt_rules_action(state, "Equip", {"actor": "player", "item": entity_id})
        if result is not None and result.status == "failed":
            state.message = f"Action failed: {result.error}"
            return
    state.equipment[item.equipment_slot] = item.id
    clear_notice(state)


def use_command(world: StoryWorld, state: GameState, remainder: str) -> None:
    if not remainder:
        state.message = "Use what?"
        return
    source_text, separator, target_text = remainder.partition(" on ")
    source, error = find_named_target(source_text, inventory_object_targets(state))
    if error:
        state.message = error
        return
    if source is None:
        source, error = find_named_target(source_text, usable_visible_object_targets(world, state))
        if error:
            state.message = error
            return
    if source is None:
        state.message = f"You cannot use {source_text}."
        return
    if not separator:
        handle_interaction_choice(state, InteractionChoice("object", source.value, "Use"), 0)
        return
    target, error = find_named_target(target_text, use_targets_for_prompt(world, state, source.value))
    if error:
        state.message = error
        return
    if target is None:
        state.message = f"You cannot use {source.name} on {target_text}."
        return
    state.use_source_item_id = source.value.id
    state.use_return_view = "system"
    use_item_on_target(state, target.value)


def adventure_named_targets(world: StoryWorld, state: GameState) -> list[NamedTarget]:
    return [
        *navigation_targets(world, state),
        *jump_targets(world, state),
        *examine_targets(world, state),
        *take_targets(world, state),
        *talk_targets(world, state),
        *board_targets(world, state),
        *inventory_object_targets(state),
    ]


def navigation_targets(world: StoryWorld, state: GameState) -> list[NamedTarget]:
    system = world.system_by_id(state.system_id)
    destination = current_destination(world, state)
    if destination is not None:
        targets = [
            named_target("destination", child.name, (index, child), child.id, child.kind)
            for index, child in visible_destination_entries(state, destination)
        ]
        orbital = current_orbital(world, state)
        linked_destinations = linked_destination_entries(state, orbital, destination) if orbital is not None else []
        for path, path_destination in linked_destinations:
            targets.append(
                named_target(
                    "path_destination",
                    path_destination.name,
                    (path, path_destination),
                    path_destination.id,
                    path_destination.kind,
                )
            )
        return targets
    orbital = current_orbital(world, state)
    if orbital is not None:
        return landing_targets(state, orbital)
    return [named_target("orbital", orbital.name, orbital, orbital.id, orbital.type) for orbital in system.orbitals]


def landing_targets(state: GameState, orbital: Orbital) -> list[NamedTarget]:
    return [
        named_target("landing", destination.name, (index, destination), destination.id, destination.kind)
        for index, destination in enumerate(orbital.landing_options)
        if destination_visible(state, destination)
    ]


def jump_targets(world: StoryWorld, state: GameState) -> list[NamedTarget]:
    system = world.system_by_id(state.system_id)
    return [named_target("system", hop.name, hop, hop.id) for hop in sorted_hops(world, system)]


def examine_targets(world: StoryWorld, state: GameState) -> list[NamedTarget]:
    targets: list[NamedTarget] = []
    destination = current_destination(world, state)
    if destination is not None and not boarded_ship_at_destination(state, destination):
        targets.extend(named_target("object", story_object.name, story_object, story_object.id) for story_object in visible_objects_for_destination(state, destination))
        targets.extend(named_target("npc", npc.name, npc, npc.id) for npc in visible_npcs_for_destination(state, destination))
        targets.extend(named_target("ship", ship_display_name(state, ship), ship, ship.id, ship.name) for ship in visible_ships_for_destination(state, destination))
        targets.extend(named_target("destination", child.name, child, child.id, child.kind) for _index, child in visible_destination_entries(state, destination))
    else:
        ship = boarded_ship(state)
        targets.extend(named_target("object", story_object.name, story_object, story_object.id) for story_object in visible_objects_for_ship(state, ship))
    targets.extend(inventory_object_targets(state))
    return targets


def take_targets(world: StoryWorld, state: GameState) -> list[NamedTarget]:
    destination = current_destination(world, state)
    if destination is not None and boarded_ship_at_destination(state, destination):
        objects = visible_objects_for_ship(state, boarded_ship(state))
    elif destination is not None:
        objects = visible_objects_for_destination(state, destination)
    else:
        objects = []
    return [
        named_target("object", story_object.name, story_object, story_object.id)
        for story_object in objects
        if "Take" in story_object.interactions
    ]


def talk_targets(world: StoryWorld, state: GameState) -> list[NamedTarget]:
    destination = current_destination(world, state)
    if destination is None or boarded_ship_at_destination(state, destination):
        return []
    return [named_target("npc", npc.name, npc, npc.id) for npc in visible_npcs_for_destination(state, destination) if "Talk" in npc.interactions]


def board_targets(world: StoryWorld, state: GameState) -> list[NamedTarget]:
    destination = current_destination(world, state)
    if destination is None:
        return []
    return [named_target("ship", ship_display_name(state, ship), ship, ship.id, ship.name) for ship in boardable_ships_for_destination(state, destination)]


def inventory_object_targets(state: GameState) -> list[NamedTarget]:
    return [named_target("inventory", item.name, item, item.id) for item in inventory_items(state)]


def usable_visible_object_targets(world: StoryWorld, state: GameState) -> list[NamedTarget]:
    destination = current_destination(world, state)
    if destination is not None and boarded_ship_at_destination(state, destination):
        objects = visible_objects_for_ship(state, boarded_ship(state))
    elif destination is not None:
        objects = visible_objects_for_destination(state, destination)
    else:
        objects = []
    return [
        named_target("object", story_object.name, story_object, story_object.id)
        for story_object in objects
        if "Use" in story_object.interactions
    ]


def use_targets_for_prompt(world: StoryWorld, state: GameState, source: Any) -> list[NamedTarget]:
    targets = [target for target in inventory_object_targets(state) if target.value.id != source.id]
    destination = current_destination(world, state)
    if destination is not None and boarded_ship_at_destination(state, destination):
        targets.extend(named_target("object", item.name, item, item.id) for item in visible_objects_for_ship(state, boarded_ship(state)) if item.id != source.id)
    elif destination is not None:
        targets.extend(named_target("object", item.name, item, item.id) for item in visible_objects_for_destination(state, destination) if item.id != source.id)
    return targets


def named_target(kind: str, name: str, value: Any, *extra_aliases: str) -> NamedTarget:
    aliases = normalized_aliases(name, *extra_aliases)
    return NamedTarget(kind, name, value, tuple(sorted(aliases)))


def normalized_aliases(name: str, *extra_aliases: str) -> set[str]:
    aliases = {normalize_command(name)}
    for alias in extra_aliases:
        if not alias:
            continue
        aliases.add(normalize_command(alias))
        aliases.add(normalize_command(alias.replace("-", " ")))
        aliases.add(normalize_command(alias.replace(":", " ")))
        aliases.add(normalize_command(alias.replace(":", " ").replace("-", " ")))
        aliases.add(normalize_command(alias.split(":")[-1].replace("-", " ")))
    return {alias for alias in aliases if alias}


def find_named_target(target_name: str, targets: list[NamedTarget]) -> tuple[NamedTarget | None, str | None]:
    normalized = normalize_command(target_name)
    if not normalized:
        return None, None
    exact = [target for target in targets if normalized in target.aliases]
    if len(exact) == 1:
        return exact[0], None
    if len(exact) > 1:
        return None, ambiguous_target_message(exact)
    prefix = [target for target in targets if any(alias.startswith(normalized) for alias in target.aliases)]
    if len(prefix) == 1:
        return prefix[0], None
    if len(prefix) > 1:
        return None, ambiguous_target_message(prefix)
    return None, None


def ambiguous_target_message(targets: list[NamedTarget]) -> str:
    names = sorted({target.name for target in targets})
    return "Ambiguous: " + format_name_list(names) + "."


def command_to_key(command: str, state: GameState) -> int | None:
    normalized = normalize_command(command)
    if state.continue_message or sequence_active(state):
        return 10
    if not normalized:
        return -1
    if re.fullmatch(r"[1-9]", normalized):
        return ord(normalized)
    match = re.fullmatch(r"(?:go|jump|enter|select|choose|use|examine|talk|take|board)\s+([1-9])", normalized)
    if match:
        return ord(match.group(1))
    if len(normalized) == 1:
        return ord(normalized)

    if state.view == "main_menu":
        menu_commands = {
            "continue": "1",
            "new": "2",
            "new game": "2",
            "save": "3",
            "restore": "4",
            "load": "4",
            "quit": "5",
            "exit": "5",
        }
        if normalized in menu_commands:
            return ord(menu_commands[normalized])

    command_map = {
        "look": -1,
        "help": -1,
        "inventory": ord("i"),
        "inv": ord("i"),
        "menu": ord("q"),
        "quit": ord("q"),
        "exit": ord("q"),
        "back": ord("g"),
        "go back": ord("g"),
        "leave": ord("l"),
        "leave system": ord("l"),
        "land": ord("l"),
        "map": ord("m"),
        "travel": ord("t"),
        "take off": ord("t"),
        "takeoff": ord("t"),
        "board": ord("b"),
        "refuel": ord("f"),
        "examine": ord("x"),
        "equip": ord("e"),
        "use": ord("u"),
        "add": ord("a"),
        "delete": ord("d"),
        "edit": ord("e"),
        "reload": ord("r"),
        "escape": 27,
        "esc": 27,
    }
    return command_map.get(normalized)


def handle_inventory_input(state: GameState, key: int) -> None:
    items = inventory_items(state)
    index = key - ord("1")
    if 0 <= index < len(items):
        state.inventory_index = index
        return

    if key in (ord("g"), ord("G"), ord("i"), ord("I")):
        state.view = state.inventory_return_view
        clear_notice(state)
        return

    if not items:
        return

    if state.inventory_index >= len(items):
        state.inventory_index = max(0, len(items) - 1)
    selected = items[state.inventory_index]

    if key in (ord("x"), ord("X")):
        start_continue_message(state, selected.description)
        return

    if key in (ord("e"), ord("E")):
        if not selected.equipment_slot:
            state.message = "You cannot equip that."
            return
        entity_id = entity_id_for_local_id(state, selected.id)
        if entity_id:
            result = attempt_rules_action(state, "Equip", {"actor": "player", "item": entity_id})
            if result is not None and result.status == "failed":
                state.message = f"Action failed: {result.error}"
                return
        state.equipment[selected.equipment_slot] = selected.id

    if key in (ord("u"), ord("U")) and "Use" in selected.interactions:
        state.use_source_item_id = selected.id
        state.use_return_view = state.inventory_return_view
        state.view = "use_scope"


def handle_use_scope_input(state: GameState, key: int) -> None:
    if key == ord("1"):
        state.view = "use_inventory_target"
        return
    if key == ord("2"):
        state.view = "use_room_target"
        return
    if key in (ord("g"), ord("G")):
        state.view = "inventory"
        return


def handle_use_target_input(world: StoryWorld, state: GameState, key: int) -> None:
    if key in (ord("g"), ord("G")):
        state.view = "use_scope"
        return
    targets = use_targets(world, state)
    index = key - ord("1")
    if 0 <= index < len(targets):
        use_item_on_target(state, targets[index])


def inventory_items(state: GameState) -> list[StoryObject]:
    return list(state.inventory.values())


def current_destination_id(state: GameState, orbital: Orbital) -> str | None:
    destination = destination_at_path(orbital, state.destination_path)
    return destination.id if destination is not None else None


def reload_world_preserving_state(world: StoryWorld, data_path: Path, state: GameState) -> StoryWorld:
    destination_ids = current_destination_ids(world, state.destination_path, state.system_id, state.orbital_id)
    docked_destination_ids = current_destination_ids(world, state.docked_path, state.system_id, state.orbital_id)
    new_world = load_world(data_path)
    new_world.system_by_id(state.system_id)

    new_destination_path: tuple[int, ...] = ()
    new_docked_path: tuple[int, ...] = ()
    if state.orbital_id is not None:
        new_orbital = orbital_by_id(new_world.system_by_id(state.system_id), state.orbital_id)
        new_destination_path = destination_path_by_ids(new_orbital, destination_ids)
        new_docked_path = destination_path_by_ids(new_orbital, docked_destination_ids)

    remapped_last_orbitals: dict[str, str] = {}
    for system_id, orbital_id in state.last_orbital_by_system.items():
        system = new_world.system_by_id(system_id)
        orbital_by_id(system, orbital_id)
        remapped_last_orbitals[system_id] = orbital_id

    new_objects = objects_by_id(new_world)
    state.inventory = {
        object_id: new_objects.get(object_id, story_object)
        for object_id, story_object in state.inventory.items()
    }
    new_ships = ships_by_id(new_world)
    new_ship_locations = authored_ship_locations(new_world)
    state.ships = new_ships
    state.ship_locations = {
        ship_id: state.ship_locations.get(ship_id, new_ship_locations.get(ship_id, "unknown"))
        for ship_id in new_ships
    }
    if state.player_ship_id not in new_ships:
        state.player_ship_id = None
    if state.boarded_ship_id not in new_ships:
        state.boarded_ship_id = None
    state.destination_path = list(new_destination_path)
    state.docked_path = list(new_docked_path)
    state.last_orbital_by_system = remapped_last_orbitals
    state.interaction_index = None
    clear_notice(state)
    attach_rules_runtime(new_world, state)
    return new_world


def objects_by_id(world: StoryWorld) -> dict[str, StoryObject]:
    objects: dict[str, StoryObject] = {}
    for system in world.systems:
        for orbital in system.orbitals:
            collect_objects_by_id(orbital.landing_options, objects)
    return objects


def collect_objects_by_id(destinations: tuple[LandingOption, ...], objects: dict[str, StoryObject]) -> None:
    for destination in destinations:
        for story_object in destination.objects:
            objects[story_object.id] = story_object
        for ship in destination.ships:
            for story_object in ship.objects:
                objects[story_object.id] = story_object
        collect_objects_by_id(destination.destinations, objects)


def ships_by_id(world: StoryWorld) -> dict[str, Ship]:
    ships: dict[str, Ship] = {}
    for system in world.systems:
        for orbital in system.orbitals:
            collect_ships_by_id(orbital.landing_options, ships)
    return ships


def collect_ships_by_id(destinations: tuple[LandingOption, ...], ships: dict[str, Ship]) -> None:
    for destination in destinations:
        for ship in destination.ships:
            ships[ship.id] = ship
        collect_ships_by_id(destination.destinations, ships)


def authored_ship_locations(world: StoryWorld) -> dict[str, str]:
    locations: dict[str, str] = {}
    for system in world.systems:
        for orbital in system.orbitals:
            collect_authored_ship_locations(orbital.landing_options, locations)
    return locations


def collect_authored_ship_locations(destinations: tuple[LandingOption, ...], locations: dict[str, str]) -> None:
    for destination in destinations:
        for ship in destination.ships:
            locations[ship.id] = destination.id
        collect_authored_ship_locations(destination.destinations, locations)


def current_destination_ids(
    world: StoryWorld,
    destination_path: list[int],
    system_id: str,
    orbital_id: str | None,
) -> tuple[str, ...]:
    if orbital_id is None or not destination_path:
        return ()
    orbital = orbital_by_id(world.system_by_id(system_id), orbital_id)
    destination_ids: list[str] = []
    destinations = orbital.landing_options
    for index in destination_path:
        if index < 0 or index >= len(destinations):
            raise ValueError("current destination no longer exists")
        destination = destinations[index]
        destination_ids.append(destination.id)
        destinations = destination.destinations
    return tuple(destination_ids)


def initial_game_state(world: StoryWorld, editor_enabled: bool) -> GameState:
    state = GameState(system_id=world.start_system, editor_enabled=editor_enabled)
    state.ships = ships_by_id(world)
    state.ship_locations = authored_ship_locations(world)
    state.ship_fuel = {ship_id: 0 for ship_id in state.ships}
    controlled_ships = [ship.id for ship in state.ships.values() if ship.controlled]
    if controlled_ships:
        state.player_ship_id = controlled_ships[0]
    attach_rules_runtime(world, state)
    if world.start_orbital_id is None:
        return state

    state.orbital_id = world.start_orbital_id
    orbital = orbital_by_id(world.system_by_id(world.start_system), world.start_orbital_id)
    destination_path = destination_path_by_ids(orbital, world.start_destination_ids)
    state.docked_path = list(destination_path)
    state.destination_path = list(destination_path)
    state.current_location_id = world.start_destination_ids[-1] if world.start_destination_ids else None
    return state


def attach_rules_runtime(world: StoryWorld, state: GameState) -> None:
    if world.rules_definition is None:
        raise ValueError("story world was not loaded from Qualms YAML")
    state.rules_definition = world.rules_definition
    state.rules_engine = RulesEngine(state.rules_definition)
    state.local_id_map = dict(state.rules_definition.metadata.get("local_id_map", {}))
    sync_rules_state_from_local(state)
    apply_rules_result_to_local(state)


def sync_rules_state_from_local(state: GameState) -> None:
    if state.rules_definition is None:
        return
    rules_state = state.rules_definition.instantiate()
    player_location_id = entity_id_for_local_id(state, state.current_location_id)
    if player_location_id:
        try_assert(rules_state, "At", ["player", player_location_id])
    for fact in state.facts:
        rules_state.memory.set(fact)
        parts = fact.split(":")
        if len(parts) == 3 and parts[0] == "fuel-station" and parts[2] == "active":
            station_entity_id = entity_id_for_local_id(state, parts[1])
            if station_entity_id:
                try_assert(rules_state, "FuelStationActive", [station_entity_id])
    for object_id in state.inventory:
        entity_id = entity_id_for_local_id(state, object_id)
        if entity_id:
            try_assert(rules_state, "CarriedBy", ["player", entity_id])
    for slot, object_id in state.equipment.items():
        rules_state.memory.set(f"equipped:slot:{slot}")
        entity_id = entity_id_for_local_id(state, object_id)
        if entity_id:
            try_assert(rules_state, "Equipped", ["player", entity_id])
    for object_id, location in state.object_locations.items():
        entity_id = entity_id_for_local_id(state, object_id)
        if entity_id is None:
            continue
        if location == "inventory":
            try_assert(rules_state, "CarriedBy", ["player", entity_id])
        else:
            location_id = entity_id_for_local_id(state, location)
            if location_id:
                try_assert(rules_state, "At", [entity_id, location_id])
    for ship_id, location in state.ship_locations.items():
        ship_entity_id = entity_id_for_local_id(state, ship_id)
        if ship_entity_id is None:
            continue
        if location.startswith("orbit:"):
            parts = location.split(":")
            if len(parts) == 3:
                system_id = entity_id_for_local_id(state, parts[1])
                orbital_id = entity_id_for_local_id(state, parts[2])
                if system_id:
                    try_assert(rules_state, "At", [ship_entity_id, system_id])
                if orbital_id:
                    try_assert(rules_state, "InOrbit", [ship_entity_id, orbital_id])
        elif location.startswith("system:"):
            parts = location.split(":")
            if len(parts) == 2:
                system_id = entity_id_for_local_id(state, parts[1])
                if system_id:
                    try_assert(rules_state, "At", [ship_entity_id, system_id])
        else:
            location_id = entity_id_for_local_id(state, location)
            if location_id:
                try_assert(rules_state, "DockedAt", [ship_entity_id, location_id])
        try_set_field(rules_state, ship_entity_id, "Vehicle", "jump_fuel", int(state.ship_fuel.get(ship_id, 0)))
    if state.player_ship_id:
        ship_entity_id = entity_id_for_local_id(state, state.player_ship_id)
        if ship_entity_id:
            try_assert(rules_state, "ControlledBy", [ship_entity_id, "player"])
            rules_state.memory.set(f"ship:{state.player_ship_id}:owned")
    if state.boarded_ship_id:
        ship_entity_id = entity_id_for_local_id(state, state.boarded_ship_id)
        if ship_entity_id:
            try_assert(rules_state, "Aboard", ["player", ship_entity_id])
            rules_state.memory.set("Aboard", ["player", ship_entity_id])
            rules_state.memory.set(f"ship:{state.boarded_ship_id}:boarded")
    state.rules_state = rules_state


def try_assert(rules_state: Any, relation: str, args: list[str]) -> None:
    try:
        rules_state.assert_relation(relation, args)
    except (KeyError, ValueError):
        return


def try_set_field(rules_state: Any, entity_id: str, trait: str, field: str, value: Any) -> None:
    try:
        rules_state.set_field(entity_id, trait, field, value)
    except (KeyError, ValueError):
        return


def entity_id_for_local_id(state: GameState, local_id: str | None) -> str | None:
    if local_id is None:
        return None
    return state.local_id_map.get(local_id)


def attempt_rules_action(state: GameState, action_id: str, args: dict[str, Any]):
    if state.rules_engine is None:
        return None
    sync_rules_state_from_local(state)
    result = state.rules_engine.attempt(state.rules_state, ActionAttempt(action_id, args))
    apply_rules_result_to_local(state)
    return result


def apply_rules_result_to_local(state: GameState) -> None:
    if state.rules_state is None:
        return
    for fact_id, args in state.rules_state.memory.facts:
        if args:
            continue
        apply_runtime_fact(state, fact_id)
    for ship_id in state.ships:
        ship_entity_id = entity_id_for_local_id(state, ship_id)
        if ship_entity_id and relation_true(state, "ControlledBy", [ship_entity_id, "player"]):
            state.player_ship_id = ship_id
        if ship_entity_id:
            try:
                state.ship_fuel[ship_id] = int(state.rules_state.get_field(ship_entity_id, "Vehicle", "jump_fuel") or 0)
            except (KeyError, TypeError, ValueError):
                state.ship_fuel.setdefault(ship_id, 0)


def apply_runtime_fact(state: GameState, fact_id: str) -> None:
    parts = fact_id.split(":")
    if len(parts) == 3 and parts[0] == "ship" and parts[2] == "control":
        state.player_ship_id = parts[1]
    else:
        state.facts.add(fact_id)


def relation_true(state: GameState, relation: str, args: list[str]) -> bool:
    if state.rules_state is None:
        return False
    try:
        return bool(state.rules_state.test(relation, args))
    except (KeyError, ValueError):
        return False


def action_texts(result: Any) -> tuple[str, ...]:
    if result is None:
        return ()
    return tuple(str(event["text"]) for event in result.events if event.get("text"))


def start_action_messages(state: GameState, result: Any, fallback: str | None = None) -> None:
    messages = action_texts(result)
    if len(messages) == 1:
        start_continue_message(state, messages[0])
    elif messages:
        start_message_sequence(state, messages)
    elif fallback:
        start_continue_message(state, fallback)


def interaction_action_attempt(state: GameState, choice: InteractionChoice):
    entity_id = entity_id_for_local_id(state, choice.target.id)
    if entity_id is None:
        return None
    if choice.interaction == "Examine":
        return attempt_rules_action(state, "Examine", {"actor": "player", "target": entity_id})
    if choice.interaction == "Take":
        return attempt_rules_action(state, "Take", {"actor": "player", "item": entity_id})
    if choice.interaction == "Use":
        return attempt_rules_action(state, "Use", {"actor": "player", "source": entity_id})
    if choice.interaction == "Power up":
        return attempt_rules_action(state, "PowerUp", {"actor": "player", "target": entity_id})
    if choice.interaction == "Talk":
        return attempt_rules_action(state, "Talk", {"actor": "player", "target": entity_id})
    if choice.interaction == "Board":
        return attempt_rules_action(state, "Board", {"actor": "player", "ship": entity_id})
    return None


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


def destination_path_by_ids(orbital: Orbital, destination_ids: tuple[str, ...]) -> tuple[int, ...]:
    destinations = orbital.landing_options
    path: list[int] = []
    for destination_id in destination_ids:
        for index, destination in enumerate(destinations):
            if destination.id == destination_id:
                path.append(index)
                destinations = destination.destinations
                break
        else:
            raise KeyError(destination_id)
    return tuple(path)


def object_choices_for_destination(state: GameState, destination: LandingOption) -> list[InteractionChoice]:
    choices: list[InteractionChoice] = []
    for story_object in visible_objects_for_destination(state, destination):
        for interaction in story_object.interactions:
            choices.append(InteractionChoice("object", story_object, interaction))
    return choices


def npc_choices_for_destination(state: GameState, destination: LandingOption) -> list[InteractionChoice]:
    choices: list[InteractionChoice] = []
    for npc in visible_npcs_for_destination(state, destination):
        for interaction in npc.interactions:
            choices.append(InteractionChoice("npc", npc, interaction))
    return choices


def visible_objects_for_destination(state: GameState, destination: LandingOption) -> list[StoryObject]:
    return [
        story_object
        for story_object in destination.objects
        if object_is_at_authored_location(state, story_object)
        and fact_conditions_met(state, story_object.visible_when, story_object.visible_unless)
    ]


def visible_objects_for_ship(state: GameState, ship: Ship | None) -> list[StoryObject]:
    if ship is None:
        return []
    return [
        story_object
        for story_object in ship.objects
        if object_is_at_authored_location(state, story_object)
        and fact_conditions_met(state, story_object.visible_when, story_object.visible_unless)
    ]


def visible_npcs_for_destination(state: GameState, destination: LandingOption) -> list[NPC]:
    return [
        npc
        for npc in destination.npcs
        if fact_conditions_met(state, npc.visible_when, npc.visible_unless)
    ]


def visible_ships_for_destination(state: GameState, destination: LandingOption) -> list[Ship]:
    return [
        ship
        for ship in state.ships.values()
        if state.ship_locations.get(ship.id) == destination.id
        and fact_conditions_met(state, ship.visible_when, ship.visible_unless)
    ]


def boardable_ships_for_destination(state: GameState, destination: LandingOption) -> list[Ship]:
    return [
        ship
        for ship in visible_ships_for_destination(state, destination)
        if ship.unlock or state.player_ship_id == ship.id
    ]


def boarded_ship(state: GameState) -> Ship | None:
    if state.boarded_ship_id is None:
        return None
    return state.ships.get(state.boarded_ship_id)


def selected_use_source(state: GameState) -> StoryObject | None:
    if state.use_source_item_id is None:
        return None
    return state.inventory.get(state.use_source_item_id)


def boarded_ship_at_destination(state: GameState, destination: LandingOption) -> bool:
    return (
        state.boarded_ship_id is not None
        and state.ship_locations.get(state.boarded_ship_id) == destination.id
    )


def board_ship_at_destination(state: GameState, destination: LandingOption) -> None:
    ships = boardable_ships_for_destination(state, destination)
    if not ships:
        return
    ship = ships[0]
    ship_entity_id = entity_id_for_local_id(state, ship.id)
    if ship_entity_id:
        result = attempt_rules_action(state, "Board", {"actor": "player", "ship": ship_entity_id})
        if result is not None and result.status == "failed":
            state.message = f"Action failed: {result.error}"
            return
        if result is not None and result.status == "blocked":
            start_action_messages(state, result)
            return
    state.boarded_ship_id = ship.id
    state.facts.add(f"ship:{ship.id}:visited")
    state.facts.add(f"ship:{ship.id}:identified")
    clear_notice(state)


def ship_status_lines(state: GameState, ship: Ship | None) -> list[str]:
    if ship is None:
        return []
    return [
        "Ship status:",
        f"Jump fuel: {state.ship_fuel.get(ship.id, 0)}",
    ]


def blocked_result(message: str) -> ActionResult:
    return ActionResult("blocked", ({"type": "emit", "text": message},))


def jump_boarded_ship_to_system(state: GameState, destination: System) -> ActionResult | None:
    ship_id = state.boarded_ship_id or state.player_ship_id
    if ship_id is None:
        return blocked_result("You need a ship to leave the system.")
    ship_entity_id = entity_id_for_local_id(state, ship_id)
    destination_system_id = entity_id_for_local_id(state, destination.id)
    if ship_entity_id is None or destination_system_id is None:
        return blocked_result("The ship cannot jump.")

    result = attempt_rules_action(
        state,
        "Jump",
        {
            "actor": "player",
            "ship": ship_entity_id,
            "destination_system": destination_system_id,
        },
    )
    if result is not None and result.status == "rejected":
        return blocked_result("The ship cannot jump.")
    if result is not None and result.status in {"failed", "blocked"}:
        return result

    state.last_system_id = state.system_id
    state.system_id = destination.id
    state.view = "system"
    state.orbital_id = None
    state.docked_path.clear()
    state.destination_path.clear()
    state.interaction_index = None
    state.ship_locations[ship_id] = f"system:{destination.id}"
    clear_notice(state)
    return result


def fuel_station_active_fact(station_id: str) -> str:
    return f"fuel-station:{station_id}:active"


def fuel_station_empty_fact(station_id: str) -> str:
    return f"fuel-station:{station_id}:empty"


def active_fuel_station_for_destination(state: GameState, destination: LandingOption) -> StoryObject | None:
    for story_object in visible_objects_for_destination(state, destination):
        if not story_object.fuel_station:
            continue
        if state_has_fact(state, fuel_station_empty_fact(story_object.id)):
            continue
        station_entity_id = entity_id_for_local_id(state, story_object.id)
        if state_has_fact(state, fuel_station_active_fact(story_object.id)):
            return story_object
        if station_entity_id and relation_true(state, "FuelStationActive", [station_entity_id]):
            return story_object
    return None


def can_refuel_boarded_ship(state: GameState, destination: LandingOption, ship: Ship) -> bool:
    return state.boarded_ship_id == ship.id and active_fuel_station_for_destination(state, destination) is not None


def refuel_boarded_ship(state: GameState, destination: LandingOption) -> None:
    ship = boarded_ship(state)
    station = active_fuel_station_for_destination(state, destination)
    if ship is None or station is None:
        start_continue_message(state, "The fueling station is powered down.")
        return
    ship_entity_id = entity_id_for_local_id(state, ship.id)
    station_entity_id = entity_id_for_local_id(state, station.id)
    if ship_entity_id is None or station_entity_id is None:
        state.message = "Refuel failed: missing runtime entity."
        return
    result = attempt_rules_action(
        state,
        "Refuel",
        {
            "actor": "player",
            "ship": ship_entity_id,
            "station": station_entity_id,
        },
    )
    if result is not None and result.status == "failed":
        state.message = f"Action failed: {result.error}"
        return
    if result is not None and result.status == "blocked":
        start_action_messages(state, result)
        return
    state.facts.add(fuel_station_empty_fact(station.id))
    start_action_messages(state, result, "Refueled.")


def take_off_from_destination(state: GameState) -> None:
    if state.boarded_ship_id is None or state.orbital_id is None:
        return
    ship = boarded_ship(state)
    if ship is None or not ship_controlled_by_player(state, ship):
        return
    ship_entity_id = entity_id_for_local_id(state, ship.id)
    orbital_entity_id = entity_id_for_local_id(state, state.orbital_id)
    if ship_entity_id and orbital_entity_id:
        result = attempt_rules_action(
            state,
            "TakeOff",
            {"actor": "player", "ship": ship_entity_id, "orbital": orbital_entity_id},
        )
        if result is not None and result.status == "failed":
            state.message = f"Action failed: {result.error}"
            return
        if result is not None and result.status == "blocked":
            start_action_messages(state, result)
            return
    state.ship_locations[state.boarded_ship_id] = f"orbit:{state.system_id}:{state.orbital_id}"
    state.last_orbital_by_system[state.system_id] = state.orbital_id
    state.docked_path.clear()
    state.destination_path.clear()
    state.interaction_index = None
    clear_notice(state)


def landing_path_for_orbital(state: GameState, orbital: Orbital) -> list[int]:
    if state.boarded_ship_id and orbital.default_landing_destination_ids:
        return list(destination_path_by_ids(orbital, orbital.default_landing_destination_ids))
    if orbital.landing_options:
        return [0]
    return []


def land_boarded_ship(state: GameState, orbital: Orbital, landing_path: list[int]) -> None:
    if state.boarded_ship_id is None:
        return
    destination = destination_at_path(orbital, landing_path)
    if destination is not None:
        ship_entity_id = entity_id_for_local_id(state, state.boarded_ship_id)
        destination_entity_id = entity_id_for_local_id(state, destination.id)
        if ship_entity_id and destination_entity_id:
            result = attempt_rules_action(
                state,
                "Land",
                {"actor": "player", "ship": ship_entity_id, "destination": destination_entity_id},
            )
            if result is not None and result.status == "failed":
                state.message = f"Action failed: {result.error}"
                return
            if result is not None and result.status == "blocked":
                start_action_messages(state, result)
                return
        state.ship_locations[state.boarded_ship_id] = destination.id
        state.boarded_ship_id = None


def ship_controlled_by_player(state: GameState, ship: Ship) -> bool:
    return state.player_ship_id == ship.id


def visible_destination_entries(state: GameState, destination: LandingOption) -> list[tuple[int, LandingOption]]:
    return [
        (index, child)
        for index, child in enumerate(destination.destinations)
        if destination_visible(state, child)
    ]


def destination_visible(state: GameState, destination: LandingOption) -> bool:
    return fact_conditions_met(state, destination.visible_when, destination.visible_unless)


def object_is_at_authored_location(state: GameState, story_object: StoryObject) -> bool:
    if not story_object.collectable:
        return True
    return state.object_locations.get(story_object.id, "authored") == "authored"


def ship_interactions(ship: Ship) -> tuple[str, ...]:
    return ("Examine",)


def ship_tagline(state: GameState, destination: LandingOption, ship: Ship) -> str:
    for tagline in ship.taglines:
        if fact_conditions_met(state, tagline.when, tagline.unless):
            return tagline.text
    disposition = "docked" if destination.port else "parked"
    return f"The {ship_display_name(state, ship)} is {disposition} here."


def ship_display_name(state: GameState, ship: Ship) -> str:
    for display_name in ship.display_names:
        if fact_conditions_met(state, display_name.when, display_name.unless):
            return display_name.text
    return ship.name


def ship_interior_description(state: GameState, ship: Ship | None) -> str:
    if ship is None:
        return ""
    for description in ship.interior_descriptions:
        if fact_conditions_met(state, description.when, description.unless):
            return description.text
    return ""


def ship_choices_for_destination(state: GameState, destination: LandingOption) -> list[InteractionChoice]:
    choices: list[InteractionChoice] = []
    for ship in visible_ships_for_destination(state, destination):
        for interaction in ship_interactions(ship):
            choices.append(InteractionChoice("ship", ship, interaction))
    return choices


def ship_object_choices(state: GameState, ship: Ship | None) -> list[InteractionChoice]:
    choices: list[InteractionChoice] = []
    for story_object in visible_objects_for_ship(state, ship):
        for interaction in story_object.interactions:
            choices.append(InteractionChoice("object", story_object, interaction))
    return choices


def destination_interaction_choices(state: GameState, destination: LandingOption) -> list[InteractionChoice]:
    return [
        *object_choices_for_destination(state, destination),
        *npc_choices_for_destination(state, destination),
        *ship_choices_for_destination(state, destination),
    ]


def interaction_choice_label(state: GameState, choice: InteractionChoice) -> str:
    if isinstance(choice.target, Ship):
        return ship_display_name(state, choice.target)
    return choice.target.name


def handle_interaction_choice(state: GameState, choice: InteractionChoice, choice_index: int) -> None:
    result = interaction_action_attempt(state, choice)
    if result is not None and result.status == "failed":
        state.message = f"Action failed: {result.error}"
        state.interaction_index = None
        return
    if result is not None and result.status == "blocked":
        start_action_messages(state, result)
        state.interaction_index = None
        return
    if choice.kind == "npc" and choice.interaction == "Examine":
        result = None
    if choice.kind == "object" and choice.interaction == "Take":
        story_object = choice.target
        if isinstance(story_object, StoryObject):
            if not story_object.collectable:
                start_continue_message(state, "You cannot take that.")
                state.interaction_index = None
                return
            if story_object.id in state.inventory:
                start_continue_message(state, "You already have that.")
                state.interaction_index = None
                return
            state.inventory[story_object.id] = story_object
            state.object_locations[story_object.id] = "inventory"
            state.inventory_index = len(state.inventory) - 1
            state.interaction_index = None
            clear_notice(state)
            return
    if choice.kind == "ship" and choice.interaction == "Board":
        start_action_messages(state, result, interaction_description(choice))
        state.interaction_index = None
        return
    start_action_messages(state, result, interaction_description(choice))
    state.interaction_index = None


def use_targets(world: StoryWorld, state: GameState) -> list[StoryObject]:
    if state.view == "use_inventory_target":
        source_id = state.use_source_item_id
        return [item for item in inventory_items(state) if item.id != source_id]
    if state.view != "use_room_target":
        return []
    ship = boarded_ship(state)
    if ship is not None:
        return visible_objects_for_ship(state, ship)
    if state.orbital_id is None:
        return []
    try:
        orbital = orbital_by_id(world.system_by_id(state.system_id), state.orbital_id)
    except KeyError:
        return []
    destination = destination_at_path(orbital, state.destination_path)
    if destination is None:
        return []
    return visible_objects_for_destination(state, destination)


def use_item_on_target(state: GameState, target: StoryObject) -> None:
    source = selected_use_source(state)
    if source is None:
        state.view = "inventory"
        return
    source_entity_id = entity_id_for_local_id(state, source.id)
    target_entity_id = entity_id_for_local_id(state, target.id)
    result = None
    if source_entity_id and target_entity_id:
        result = attempt_rules_action(
            state,
            "Use",
            {
                "actor": "player",
                "source": source_entity_id,
                "target": target_entity_id,
            },
        )
    state.view = state.use_return_view
    state.use_source_item_id = None
    if result is not None and result.status == "failed":
        state.message = f"Action failed: {result.error}"
        return
    messages = action_texts(result)
    if messages:
        start_message_sequence(state, messages)
    else:
        start_continue_message(state, "Nothing happens.")


def before_rule_message(state: GameState, choice: InteractionChoice) -> str | None:
    rule = before_rule_for_choice(state, choice)
    return rule.message if rule is not None else None


def before_rule_for_choice(state: GameState, choice: InteractionChoice) -> BeforeRule | None:
    for rule in choice.target.before:
        if rule.interaction == choice.interaction and fact_conditions_met(state, rule.when, rule.unless):
            return rule
    return None


def destination_before_rule_message(state: GameState, destination: LandingOption) -> str | None:
    for rule in destination.before:
        if rule.interaction == "Enter" and fact_conditions_met(state, rule.when, rule.unless):
            return rule.message
    return None


def attempt_enter_destination_action(state: GameState, destination: LandingOption):
    destination_entity_id = entity_id_for_local_id(state, destination.id)
    if destination_entity_id is None:
        return None
    return attempt_rules_action(state, "Enter", {"actor": "player", "destination": destination_entity_id})


def enter_destination(state: GameState, destination: LandingOption) -> None:
    state.facts.add(visited_destination_fact(destination))
    for sequence in destination.sequences:
        if fact_conditions_met(state, sequence.when, sequence.unless):
            start_sequence(state, sequence)
            return


def start_sequence(state: GameState, sequence: Sequence) -> None:
    start_message_sequence(state, sequence.messages, sequence.on_complete)


def start_continue_message(state: GameState, message: str, on_complete: tuple[str, ...] = ()) -> None:
    state.continue_message = message
    state.continue_on_complete = on_complete


def start_message_sequence(state: GameState, messages: tuple[str, ...], on_complete: tuple[str, ...] = ()) -> None:
    clear_notice(state)
    state.interaction_index = None
    state.sequence_messages = messages
    state.sequence_index = 0
    state.sequence_on_complete = on_complete


def sequence_active(state: GameState) -> bool:
    return bool(state.sequence_messages)


def advance_sequence(state: GameState) -> None:
    if not sequence_active(state):
        return
    if state.sequence_index < len(state.sequence_messages) - 1:
        state.sequence_index += 1
        return
    apply_outcomes(state, state.sequence_on_complete)
    state.sequence_messages = ()
    state.sequence_index = 0
    state.sequence_on_complete = ()


def apply_outcomes(state: GameState, outcomes: tuple[str, ...]) -> None:
    for outcome in outcomes:
        parts = outcome.split(":")
        if len(parts) == 3 and parts[0] == "ship" and parts[2] == "control":
            state.player_ship_id = parts[1]
        else:
            state.facts.add(outcome)


def visited_destination_fact(destination: LandingOption) -> str:
    return f"visited:destination:{destination.id}"


def fact_conditions_met(state: GameState, when: tuple[str, ...], unless: tuple[str, ...]) -> bool:
    return all(state_has_fact(state, fact) for fact in when) and all(not state_has_fact(state, fact) for fact in unless)


def state_has_fact(state: GameState, fact: str) -> bool:
    if fact.startswith("equipped:slot:"):
        slot = fact.removeprefix("equipped:slot:")
        return slot in state.equipment
    if fact.startswith("ship:"):
        parts = fact.split(":")
        if len(parts) == 4 and parts[2] == "at":
            return state.ship_locations.get(parts[1]) == parts[3]
        if len(parts) == 3 and parts[2] == "owned":
            return state.player_ship_id == parts[1]
        if len(parts) == 3 and parts[2] == "boarded":
            return state.boarded_ship_id == parts[1]
    return fact in state.facts


def clear_notice(state: GameState) -> None:
    state.continue_message = ""
    state.continue_on_complete = ()
    state.message = ""


def interaction_description(choice: InteractionChoice) -> str:
    if isinstance(choice.target, Ship):
        if choice.interaction == "Board":
            return f"On board the {choice.target.name}."
        return choice.target.description
    if isinstance(choice.target, NPC):
        if choice.interaction == "Examine":
            return choice.target.examine_description
        if choice.interaction == "Talk":
            return "They have nothing to say."
    if choice.interaction == "Take":
        if isinstance(choice.target, StoryObject) and not choice.target.collectable:
            return "You cannot take that."
        return f"Taken: {choice.target.name}"
    if choice.interaction == "Power up":
        return "Nothing happens."
    if choice.interaction == "Use":
        return "Nothing happens."
    return choice.target.description


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
    choice = prompt_menu(stdscr, "Add", ["Add destination", "Add object", "Add NPC"])
    if choice == 0:
        return prompt_add_landing_destination(stdscr, world, data_path, system_id, orbital_id, destination_path)
    if choice == 1:
        return prompt_add_object(stdscr, world, data_path, system_id, orbital_id, destination_path)
    if choice == 2:
        return prompt_add_npc(stdscr, world, data_path, system_id, orbital_id, destination_path)
    return None


def prompt_add_object(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
) -> tuple[StoryWorld, str] | None:
    values = prompt_name_description(stdscr, "Add Object")
    if values is None:
        return None
    name, description = values
    interaction_text = prompt_text(stdscr, "Add Object", "Interactions (Examine, Take, Use):", default="Examine")
    if interaction_text is None:
        return None
    try:
        interactions = parse_interactions(interaction_text)
        return add_object(world, data_path, system_id, orbital_id, destination_path, name, description, interactions), f"Added object: {name}"
    except ValueError as error:
        return world, str(error)


def prompt_add_npc(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
) -> tuple[StoryWorld, str] | None:
    name = prompt_text(stdscr, "Add NPC", "Name:")
    if name is None:
        return None
    description = prompt_multiline_text(stdscr, "Add NPC", "Description")
    if description is None:
        return None
    examine_description = prompt_multiline_text(stdscr, "Add NPC", "Examine description")
    if examine_description is None:
        return None
    try:
        return add_npc(world, data_path, system_id, orbital_id, destination_path, name, description, examine_description), f"Added NPC: {name}"
    except ValueError as error:
        return world, str(error)


def parse_interactions(value: str) -> tuple[str, ...]:
    interactions: list[str] = []
    for raw_interaction in re.split(r"[,/]+", value):
        interaction = raw_interaction.strip().title()
        if not interaction:
            continue
        if interaction not in OBJECT_INTERACTIONS:
            raise ValueError(f"interaction must be one of {sorted(OBJECT_INTERACTIONS)}")
        if interaction not in interactions:
            interactions.append(interaction)
    if not interactions:
        raise ValueError("object must support at least one interaction")
    return tuple(interactions)


def prompt_delete_detail(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    destination: LandingOption,
) -> tuple[StoryWorld, str] | None:
    has_objects = bool(destination.objects)
    has_npcs = bool(destination.npcs)
    has_destinations = bool(destination.destinations)
    if not has_objects and not has_npcs and not has_destinations:
        return world, "No details to delete"

    available_types: list[str] = []
    if has_objects:
        available_types.append("Object")
    if has_npcs:
        available_types.append("NPC")
    if has_destinations:
        available_types.append("Destination")

    if len(available_types) > 1:
        choice = prompt_menu(stdscr, "Delete Detail", available_types)
        if choice is None:
            return None
        selected_type = available_types[choice]
        if selected_type == "Object":
            return prompt_delete_object(stdscr, world, data_path, system_id, orbital_id, destination_path, destination)
        if selected_type == "NPC":
            return prompt_delete_npc(stdscr, world, data_path, system_id, orbital_id, destination_path, destination)
        return prompt_delete_child_destination(stdscr, world, data_path, system_id, orbital_id, destination_path, destination)

    if has_objects:
        return prompt_delete_object(stdscr, world, data_path, system_id, orbital_id, destination_path, destination)
    if has_npcs:
        return prompt_delete_npc(stdscr, world, data_path, system_id, orbital_id, destination_path, destination)
    return prompt_delete_child_destination(stdscr, world, data_path, system_id, orbital_id, destination_path, destination)


def prompt_delete_object(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    destination: LandingOption,
) -> tuple[StoryWorld, str] | None:
    if not destination.objects:
        return world, "No objects to delete"

    lines = ["Delete Object", ""]
    for index, story_object in enumerate(destination.objects, start=1):
        lines.append(f"{index}. {story_object.name} [{', '.join(story_object.interactions)}]")
    choice = prompt_text(stdscr, "Delete Object", "Number:", lines)
    if choice is None:
        return None
    try:
        object_index = int(choice) - 1
    except ValueError:
        return world, "Enter an object number"

    try:
        name = destination.objects[object_index].name
        return delete_object(world, data_path, system_id, orbital_id, destination_path, object_index), f"Deleted object: {name}"
    except (IndexError, ValueError) as error:
        return world, str(error)


def prompt_delete_child_destination(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    destination: LandingOption,
) -> tuple[StoryWorld, str] | None:
    if not destination.destinations:
        return world, "No destinations to delete"

    lines = ["Delete Destination", ""]
    for index, child in enumerate(destination.destinations, start=1):
        lines.append(f"{index}. {child.name} [{child.kind}]")
    choice = prompt_text(stdscr, "Delete Destination", "Number:", lines)
    if choice is None:
        return None
    try:
        child_index = int(choice) - 1
    except ValueError:
        return world, "Enter a destination number"

    try:
        name = destination.destinations[child_index].name
        return delete_landing_destination(world, data_path, system_id, orbital_id, destination_path, child_index), f"Deleted destination: {name}"
    except (IndexError, ValueError) as error:
        return world, str(error)


def prompt_delete_npc(
    stdscr: curses.window,
    world: StoryWorld,
    data_path: Path,
    system_id: str,
    orbital_id: str,
    destination_path: list[int],
    destination: LandingOption,
) -> tuple[StoryWorld, str] | None:
    if not destination.npcs:
        return world, "No NPCs to delete"

    lines = ["Delete NPC", ""]
    for index, npc in enumerate(destination.npcs, start=1):
        lines.append(f"{index}. {npc.name}")
    choice = prompt_text(stdscr, "Delete NPC", "Number:", lines)
    if choice is None:
        return None
    try:
        npc_index = int(choice) - 1
    except ValueError:
        return world, "Enter an NPC number"

    try:
        name = destination.npcs[npc_index].name
        return delete_npc(world, data_path, system_id, orbital_id, destination_path, npc_index), f"Deleted NPC: {name}"
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
            if orbital.default_landing_destination_ids:
                lines.append("   default landing: " + " > ".join(orbital.default_landing_destination_ids))
            for option_index, option in enumerate(orbital.landing_options, start=1):
                dump_destination(option, lines, f"   {option_index}.")
    return "\n".join(lines)


def dump_destination(option: LandingOption, lines: list[str], prefix: str) -> None:
    flags = []
    if option.port:
        flags.append("port")
    visibility = condition_suffix(option.visible_when, option.visible_unless)
    if visibility:
        flags.append("visible " + visibility.strip())
    flag_suffix = f" ({'; '.join(flags)})" if flags else ""
    lines.append(f"{prefix} {option.name} [{option.kind}]{flag_suffix}: {option.description}")
    for rule in option.before:
        lines.append(f"      before {rule.interaction}{condition_suffix(rule.when, rule.unless)}: {rule.message}")
    for sequence in option.sequences:
        lines.append(f"      {prefix}s. sequence {sequence.id}{condition_suffix(sequence.when, sequence.unless)}")
        for message in sequence.messages:
            lines.append(f"         {message}")
    for index, story_object in enumerate(option.objects, start=1):
        dump_object(story_object, lines, f"      {prefix}o{index}.")
    for index, npc in enumerate(option.npcs, start=1):
        lines.append(f"      {prefix}n{index}. {npc.name} [{', '.join(npc.interactions)}]: {npc.description}")
        for rule in npc.before:
            lines.append(f"         before {rule.interaction}{condition_suffix(rule.when, rule.unless)}: {rule.message}")
    for index, ship in enumerate(option.ships, start=1):
        lines.append(f"      {prefix}h{index}. {ship.name} [Ship]: {ship.description}")
        if ship.unlock:
            lines.append("         unlock: true")
        if ship.controlled:
            lines.append("         controlled: true")
        if ship.equipment_slots:
            lines.append("         slots: " + ", ".join(ship.equipment_slots))
        if ship.abilities:
            lines.append("         abilities: " + ", ".join(ship.abilities))
        for object_index, story_object in enumerate(ship.objects, start=1):
            dump_object(story_object, lines, f"         h{index}.o{object_index}.")
        for display_name in ship.display_names:
            lines.append(f"         display name{condition_suffix(display_name.when, display_name.unless)}: {display_name.text}")
        for description in ship.interior_descriptions:
            lines.append(f"         interior{condition_suffix(description.when, description.unless)}: {description.text}")
        for tagline in ship.taglines:
            lines.append(f"         tagline{condition_suffix(tagline.when, tagline.unless)}: {tagline.text}")
        for rule in ship.before:
            lines.append(f"         before {rule.interaction}{condition_suffix(rule.when, rule.unless)}: {rule.message}")
            if rule.on_complete:
                lines.append("            outcomes: " + ", ".join(rule.on_complete))
    for index, child in enumerate(option.destinations, start=1):
        dump_destination(child, lines, f"   {prefix}{index}.")


def dump_object(story_object: StoryObject, lines: list[str], prefix: str) -> None:
    lines.append(f"{prefix} {story_object.name} [{', '.join(story_object.interactions)}]: {story_object.description}")
    for rule in story_object.before:
        lines.append(f"         before {rule.interaction}{condition_suffix(rule.when, rule.unless)}: {rule.message}")
        if rule.on_complete:
            lines.append("            outcomes: " + ", ".join(rule.on_complete))
    for rule in story_object.use_rules:
        lines.append(f"         use on {rule.target}{condition_suffix(rule.when, rule.unless)}")
        for message in rule.messages:
            lines.append(f"            {message}")
        if rule.on_complete:
            lines.append("            outcomes: " + ", ".join(rule.on_complete))


def condition_suffix(when: tuple[str, ...], unless: tuple[str, ...]) -> str:
    pieces = []
    if when:
        pieces.append("when " + ", ".join(when))
    if unless:
        pieces.append("unless " + ", ".join(unless))
    if not pieces:
        return ""
    return " (" + "; ".join(pieces) + ")"


def main() -> int:
    parser = argparse.ArgumentParser(description="Dark Qualms story prototype")
    parser.add_argument("data_path", nargs="?", type=Path, help="Data directory or story.qualms.yaml file")
    parser.add_argument("--data", type=Path, help="Data directory or story.qualms.yaml file")
    parser.add_argument("--editor", action="store_true", help="Expose in-game story editing commands")
    parser.add_argument("--curses", action="store_true", help="Use the legacy curses box interface")
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--dump", action="store_true")
    args = parser.parse_args()

    data_file = resolve_data_file(args.data or args.data_path or DATA_PATH)
    if args.validate:
        load_game_definition(data_file)
        print(f"story data ok: {data_file}")
        return 0

    if not args.curses and not args.editor and not args.dump:
        try:
            run_generic_cli(load_game_definition(data_file), data_file)
        except GenericCliContractError as error:
            print(f"Generic CLI contract error: {error}", file=sys.stderr)
            return 2
        return 0

    world = load_world(data_file)
    if args.dump:
        print(dump_world(world))
        return 0

    if args.curses:
        curses.wrapper(run_curses, world, data_file, args.editor)
    else:
        run_cli(world, data_file, args.editor)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

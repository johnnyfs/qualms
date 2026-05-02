#!/usr/bin/env python3
from __future__ import annotations

import argparse
import curses
import json
import re
import sys
import textwrap
from curses import ascii
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from qualms import ActionAttempt, RulesEngine
from qualms.legacy import legacy_world_to_game_definition

DATA_PATH = PROJECT_ROOT / "stories" / "stellar" / "story_systems.json"
ORBITAL_TYPES = {"Planet", "Moon", "Station"}
OPTION_KINDS = {"Bar", "Tourist Destination", "Destination"}
OBJECT_INTERACTIONS = {"Examine", "Take", "Use", "Power up"}
NPC_INTERACTIONS = {"Examine", "Talk"}
SHIP_INTERACTIONS = {"Examine", "Board"}
DESTINATION_INTERACTIONS = {"Enter"}
MAX_HOP_DISTANCE_AU = 350000.0
MAP_WIDTH = 58
MAP_HEIGHT = 17
DEFAULT_HOP_DISTANCE_AU = 200000.0


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
    inventory_return_view: str = "system"
    use_return_view: str = "inventory"
    orbital_id: str | None = None
    docked_path: list[int] = field(default_factory=list)
    destination_path: list[int] = field(default_factory=list)
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
    legacy_id_map: dict[str, str] = field(default_factory=dict)


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
    )
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
    return world


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


def game_window(stdscr: curses.window, state: GameState, width: int, lines: Iterable[str]) -> None:
    margin = editor_box_margin(stdscr, state)
    top, _left, _content_width, text = centered_window(stdscr, width, lines, bottom_margin=margin)
    if margin:
        state.editor_box_top = top + len(text) + 5
    else:
        state.editor_box_top = None


def prompt_text(
    stdscr: curses.window,
    title: str,
    prompt: str,
    context_lines: Iterable[str] = (),
    max_length: int = 64,
    default: str | None = None,
) -> str | None:
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
    stdscr: curses.window,
    title: str,
    prompt: str,
    context_lines: Iterable[str] = (),
    default: str | None = None,
) -> str | None:
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
    stdscr: curses.window,
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


def prompt_menu(stdscr: curses.window, title: str, options: list[str]) -> int | None:
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
    lines.extend(["", "Number: travel", "I: inventory", "L: leave system    M: map    Q: quit"])
    game_window(stdscr, state, 72, lines)


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
    lines.extend(["", "Number: jump", "G: go back    I: inventory    M: map    Q: quit"])
    game_window(stdscr, state, 80, lines)


def draw_map(stdscr: curses.window, world: StoryWorld, state: GameState, system: System) -> None:
    lines = [
        "Local Map",
        "",
        *build_map_lines(world, system),
        "",
        "@ current    * system    lines: available jumps",
        "G: go back",
        "I: inventory",
        "Q: quit",
    ]
    centered_window(stdscr, 76, lines)


def draw_orbit(stdscr: curses.window, state: GameState, orbital: Orbital) -> None:
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
        "Q: quit",
    ])
    game_window(stdscr, state, 72, lines)


def draw_option(stdscr: curses.window, state: GameState, orbital: Orbital, option: LandingOption) -> None:
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
        "Q: quit",
    ])
    game_window(stdscr, state, 72, lines)


def draw_boarded_ship(stdscr: curses.window, state: GameState) -> None:
    ship = boarded_ship(state)
    name = ship.name if ship is not None else "Ship"
    lines = [
        f"On board the {name}",
        "",
    ]
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
    lines.extend(["G: go back", "I: inventory", "Q: quit"])
    game_window(stdscr, state, 72, lines)


def editor_commands_for_state(state: GameState) -> list[str]:
    if not state.editor_enabled:
        return []
    if sequence_active(state) or state.continue_message or state.view in {"map", "inventory"}:
        return ["R: reload"]
    if state.view == "jump":
        return ["A: add system", "R: reload"]
    if state.destination_path:
        return ["A: add", "D: delete detail", "E: edit destination", "R: reload"]
    if state.orbital_id is None:
        return ["A: add orbital", "D: delete orbital", "E: edit system", "R: reload"]
    return ["E: edit orbital", "R: reload"]


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
    message = state.sequence_messages[state.sequence_index] if sequence_active(state) else ""
    centered_window(stdscr, 72, [message], footer="Press any key to continue")


def draw_continue_message(stdscr: curses.window, state: GameState) -> None:
    centered_window(stdscr, 72, [state.continue_message], footer="Press any key to continue")


def draw_inventory(stdscr: curses.window, state: GameState) -> None:
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
    lines.extend(["G: go back", "Q: quit"])
    centered_window(stdscr, 72, lines)


def draw_use_scope(stdscr: curses.window, state: GameState) -> None:
    source = selected_use_source(state)
    title = f"Use: {source.name}" if source is not None else "Use"
    lines = [
        title,
        "",
        "1. on an object in your inventory",
        "2. on something in the room",
        "",
        "G: go back",
        "Q: quit",
    ]
    centered_window(stdscr, 72, lines)


def draw_use_targets(stdscr: curses.window, world: StoryWorld, state: GameState) -> None:
    source = selected_use_source(state)
    title = f"Use: {source.name}" if source is not None else "Use"
    targets = use_targets(world, state)
    lines = [title, ""]
    if targets:
        for index, target in enumerate(targets, start=1):
            lines.append(f"{index}. {target.name}")
    else:
        lines.append("Nothing.")
    lines.extend(["", "G: go back", "Q: quit"])
    centered_window(stdscr, 72, lines)


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
                enter_destination(state, selected_destination)
            if sequence_active(state):
                draw_sequence(stdscr, state)
            elif selected_destination is not None and boarded_ship_at_destination(state, selected_destination):
                draw_boarded_ship(stdscr, state)
            elif selected_destination is not None:
                draw_option(stdscr, state, orbital, selected_destination)
            else:
                draw_orbit(stdscr, state, orbital)

        if not state.continue_message and not sequence_active(state):
            draw_editor_box(stdscr, state)
        stdscr.refresh()
        key = stdscr.getch()
        if not state.editor_enabled or key not in (ord("a"), ord("A")):
            state.message = ""

        if state.editor_enabled and key in (ord("r"), ord("R")):
            try:
                world = reload_world_preserving_state(world, data_path, state)
                state.message = f"Reloaded: {data_path}"
            except (OSError, json.JSONDecodeError, ValueError, KeyError) as error:
                state.message = f"Reload failed: {error}"
            continue

        if state.continue_message:
            state.continue_message = ""
            apply_outcomes(state, state.continue_on_complete)
            state.continue_on_complete = ()
            continue

        if sequence_active(state):
            advance_sequence(state)
            continue

        if key in (ord("q"), ord("Q")):
            return

        if state.view != "inventory" and key in (ord("i"), ord("I")):
            state.inventory_return_view = state.view
            state.view = "inventory"
            state.interaction_index = None
            clear_notice(state)
            continue

        if state.view == "use_scope":
            handle_use_scope_input(state, key)
            continue

        if state.view in {"use_room_target", "use_inventory_target"}:
            handle_use_target_input(world, state, key)
            continue

        if state.view == "inventory":
            handle_inventory_input(state, key)
            continue

        if state.view == "map":
            if key in (ord("g"), ord("G")):
                state.view = state.map_return_view
            continue

        if state.view == "jump":
            hops = sorted_hops(world, system)
            index = key - ord("1")
            if 0 <= index < len(hops):
                ship_id = state.boarded_ship_id or state.player_ship_id
                ship_entity_id = legacy_entity_id(state, ship_id)
                destination_system_id = legacy_entity_id(state, hops[index].id)
                if ship_entity_id and destination_system_id:
                    result = attempt_rules_action(
                        state,
                        "Jump",
                        {
                            "actor": "player",
                            "ship": ship_entity_id,
                            "destination_system": destination_system_id,
                        },
                    )
                    if result is not None and result.status == "failed":
                        state.message = f"Action failed: {result.error}"
                        continue
                    if result is not None and result.status == "blocked":
                        start_action_messages(state, result)
                        continue
                state.last_system_id = state.system_id
                state.system_id = hops[index].id
                state.view = "system"
                state.orbital_id = None
                state.docked_path.clear()
                state.destination_path.clear()
                state.interaction_index = None
                clear_notice(state)
            elif key in (ord("g"), ord("G")):
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
                state.interaction_index = None
                clear_notice(state)
                continue
            if boarded_ship_at_destination(state, selected_destination):
                ship = boarded_ship(state)
                ship_choices = ship_object_choices(state, ship)
                index = key - ord("1")
                if 0 <= index < len(ship_choices):
                    handle_interaction_choice(state, ship_choices[index], index)
                elif key in (ord("t"), ord("T")) and ship is not None and ship_controlled_by_player(state, ship):
                    take_off_from_destination(state)
                elif key in (ord("g"), ord("G")):
                    state.boarded_ship_id = None
                continue
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
                state.interaction_index = None
                clear_notice(state)
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
            landing_path = landing_path_for_orbital(state, orbital)
            if landing_path:
                state.docked_path = landing_path
                state.destination_path = list(landing_path)
                land_boarded_ship(state, orbital, landing_path)
                state.interaction_index = None
                clear_notice(state)
        elif state.editor_enabled and key in (ord("e"), ord("E")):
            edited = prompt_edit_orbital(stdscr, world, data_path, state.system_id, state.orbital_id)
            if edited is not None:
                world, state.message = edited
        elif key in (ord("t"), ord("T"), 27):
            state.orbital_id = None
            state.docked_path.clear()
            state.destination_path.clear()
            state.interaction_index = None
            clear_notice(state)


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
        entity_id = legacy_entity_id(state, selected.id)
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
    return state


def attach_rules_runtime(world: StoryWorld, state: GameState) -> None:
    state.rules_definition = legacy_world_to_game_definition(world)
    state.rules_engine = RulesEngine(state.rules_definition)
    state.legacy_id_map = dict(state.rules_definition.metadata.get("legacy_id_map", {}))
    sync_rules_state_from_legacy(state)


def sync_rules_state_from_legacy(state: GameState) -> None:
    if state.rules_definition is None:
        return
    rules_state = state.rules_definition.instantiate()
    for fact in state.facts:
        rules_state.memory.set(fact)
    for object_id in state.inventory:
        entity_id = legacy_entity_id(state, object_id)
        if entity_id:
            try_assert(rules_state, "CarriedBy", ["player", entity_id])
    for slot, object_id in state.equipment.items():
        rules_state.memory.set(f"equipped:slot:{slot}")
        entity_id = legacy_entity_id(state, object_id)
        if entity_id:
            try_assert(rules_state, "Equipped", ["player", entity_id])
    for object_id, location in state.object_locations.items():
        entity_id = legacy_entity_id(state, object_id)
        if entity_id is None:
            continue
        if location == "inventory":
            try_assert(rules_state, "CarriedBy", ["player", entity_id])
        else:
            location_id = legacy_entity_id(state, location)
            if location_id:
                try_assert(rules_state, "At", [entity_id, location_id])
    for ship_id, location in state.ship_locations.items():
        ship_entity_id = legacy_entity_id(state, ship_id)
        if ship_entity_id is None:
            continue
        if location.startswith("orbit:"):
            parts = location.split(":")
            if len(parts) == 3:
                orbital_id = legacy_entity_id(state, parts[2])
                if orbital_id:
                    try_assert(rules_state, "InOrbit", [ship_entity_id, orbital_id])
        else:
            location_id = legacy_entity_id(state, location)
            if location_id:
                try_assert(rules_state, "DockedAt", [ship_entity_id, location_id])
    if state.player_ship_id:
        ship_entity_id = legacy_entity_id(state, state.player_ship_id)
        if ship_entity_id:
            try_assert(rules_state, "ControlledBy", [ship_entity_id, "player"])
            rules_state.memory.set(f"ship:{state.player_ship_id}:owned")
    if state.boarded_ship_id:
        ship_entity_id = legacy_entity_id(state, state.boarded_ship_id)
        if ship_entity_id:
            rules_state.memory.set("Aboard", ["player", ship_entity_id])
            rules_state.memory.set(f"ship:{state.boarded_ship_id}:boarded")
    state.rules_state = rules_state


def try_assert(rules_state: Any, relation: str, args: list[str]) -> None:
    try:
        rules_state.assert_relation(relation, args)
    except (KeyError, ValueError):
        return


def legacy_entity_id(state: GameState, legacy_id: str | None) -> str | None:
    if legacy_id is None:
        return None
    return state.legacy_id_map.get(legacy_id)


def attempt_rules_action(state: GameState, action_id: str, args: dict[str, Any]):
    if state.rules_engine is None:
        return None
    sync_rules_state_from_legacy(state)
    result = state.rules_engine.attempt(state.rules_state, ActionAttempt(action_id, args))
    apply_rules_result_to_legacy(state)
    return result


def apply_rules_result_to_legacy(state: GameState) -> None:
    if state.rules_state is None:
        return
    for fact_id, args in state.rules_state.memory.facts:
        if args:
            continue
        apply_runtime_fact(state, fact_id)
    for ship_id in state.ships:
        ship_entity_id = legacy_entity_id(state, ship_id)
        if ship_entity_id and relation_true(state, "ControlledBy", [ship_entity_id, "player"]):
            state.player_ship_id = ship_id


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
    entity_id = legacy_entity_id(state, choice.target.id)
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
    ship_entity_id = legacy_entity_id(state, ship.id)
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


def take_off_from_destination(state: GameState) -> None:
    if state.boarded_ship_id is None or state.orbital_id is None:
        return
    ship = boarded_ship(state)
    if ship is None or not ship_controlled_by_player(state, ship):
        return
    ship_entity_id = legacy_entity_id(state, ship.id)
    orbital_entity_id = legacy_entity_id(state, state.orbital_id)
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
        ship_entity_id = legacy_entity_id(state, state.boarded_ship_id)
        destination_entity_id = legacy_entity_id(state, destination.id)
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
    source_entity_id = legacy_entity_id(state, source.id)
    target_entity_id = legacy_entity_id(state, target.id)
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
    destination_entity_id = legacy_entity_id(state, destination.id)
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

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml


PROJECT_ROOT = Path(__file__).resolve().parents[1]
NOVA_PRELUDE = PROJECT_ROOT / "stories" / "prelude" / "nova-qualms.qualms.yaml"


def story_world_to_yaml_data(world: Any, import_path: str = "../prelude/nova-qualms.qualms.yaml") -> dict[str, Any]:
    converter = StoryYamlConverter(import_path)
    return converter.convert(world)


def write_story_world_yaml(world: Any, output_path: str | Path, import_path: str | None = None) -> None:
    output = Path(output_path)
    effective_import = import_path
    if effective_import is None:
        effective_import = relative_import(output.parent, NOVA_PRELUDE)
    data = story_world_to_yaml_data(world, effective_import)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=False), encoding="utf-8")


class StoryYamlConverter:
    def __init__(self, import_path: str):
        self.import_path = import_path
        self.entities: list[dict[str, Any]] = []
        self.entity_by_id: dict[str, dict[str, Any]] = {}
        self.assertions: list[dict[str, Any]] = []
        self.local_id_map: dict[str, str] = {}
        self.pending_rules: list[tuple[str, str, Any]] = []

    def convert(self, world: Any) -> dict[str, Any]:
        self.add_entity(
            "player",
            "Player",
            fields={"Presentable": {"name": "Player", "description": ""}},
            metadata={"role": "player"},
        )
        for system in world.systems:
            self.convert_system(system)
        self.attach_pending_rules()
        return {
            "qualms": "0.1",
            "id": "stellar",
            "imports": [self.import_path],
            "metadata": {"local_id_map": self.local_id_map},
            "story": {
                "start": {
                    "actor": "player",
                    "system": safe_id(world.start_system),
                    **({"location": self.lookup_local_id(world.start_destination_ids[-1])} if world.start_destination_ids else {}),
                },
                "entities": self.entities,
                "assertions": self.assertions,
                "facts": [],
            },
        }

    def convert_system(self, system: Any) -> None:
        system_id = safe_id(system.id)
        self.remember_local_id(system.id, system_id)
        self.add_entity(
            system_id,
            "System",
            fields={
                "Presentable": {"name": system.name, "description": system.description},
                "StarSystem": {
                    "star_type": system.star_type,
                    "x": system.position_au[0],
                    "y": system.position_au[1],
                    "hops": [safe_id(hop_id) for hop_id in system.hops],
                },
            },
            metadata={"local_id": system.id},
        )
        for orbital in system.orbitals:
            self.convert_orbital(system, orbital, system_id)

    def convert_orbital(self, system: Any, orbital: Any, system_entity_id: str) -> None:
        orbital_id = safe_id(f"{system.id}:{orbital.id}")
        self.remember_local_id(orbital.id, orbital_id)
        kind = orbital.type if orbital.type in {"Planet", "Moon", "Station"} else "Planet"
        parent = safe_id(f"{system.id}:{orbital.parent}") if orbital.parent else None
        self.add_entity(
            orbital_id,
            kind,
            fields={
                "Presentable": {"name": orbital.name, "description": orbital.description},
                "OrbitalBody": {
                    "orbital_type": orbital.type,
                    "parent": parent,
                    "default_landing_path": list(orbital.default_landing_destination_ids),
                },
            },
            metadata={"local_id": orbital.id, "source_type": orbital.type},
        )
        self.assert_relation("At", [{"ref": orbital_id}, {"ref": system_entity_id}])
        for option in orbital.landing_options:
            self.convert_destination(option, orbital_id, [orbital_id, option.id])

    def convert_destination(self, option: Any, parent_entity_id: str, path_parts: list[str]) -> None:
        destination_id = safe_id(":".join(path_parts))
        self.remember_local_id(option.id, destination_id)
        self.add_entity(
            destination_id,
            "Destination",
            fields={"Presentable": {"name": option.name, "description": option.description}},
            metadata={
                "local_id": option.id,
                "display_kind": option.kind,
                "port": option.port,
                "visible_when": list(option.visible_when),
                "visible_unless": list(option.visible_unless),
            },
        )
        self.assert_relation("At", [{"ref": destination_id}, {"ref": parent_entity_id}])
        self.pending_rules.append((destination_id, "destination", option))
        for story_object in option.objects:
            self.convert_object(story_object, destination_id)
        for npc in option.npcs:
            self.convert_npc(npc, destination_id)
        for ship in option.ships:
            self.convert_ship(ship, destination_id)
        for child in option.destinations:
            self.convert_destination(child, destination_id, [*path_parts, child.id])

    def convert_object(self, story_object: Any, location_id: str) -> None:
        object_id = safe_id(f"{location_id}:object:{story_object.id}")
        self.remember_local_id(story_object.id, object_id)
        traits: list[dict[str, Any]] = []
        if story_object.collectable:
            traits.append({"id": "Portable"})
        if "Use" in story_object.interactions:
            traits.append({"id": "Usable"})
        if story_object.equipment_slot:
            traits.append({"id": "Equipment", "fields": {"slot": story_object.equipment_slot}})
        self.add_entity(
            object_id,
            "StoryObject",
            traits=traits,
            fields={"Presentable": {"name": story_object.name, "description": story_object.description}},
            metadata={
                "local_id": story_object.id,
                "interactions": list(story_object.interactions),
                "collectable": story_object.collectable,
                "visible_when": list(story_object.visible_when),
                "visible_unless": list(story_object.visible_unless),
            },
        )
        self.assert_relation("At", [{"ref": object_id}, {"ref": location_id}])
        self.pending_rules.append((object_id, "object", story_object))

    def convert_npc(self, npc: Any, location_id: str) -> None:
        npc_id = safe_id(f"{location_id}:npc:{npc.id}")
        self.remember_local_id(npc.id, npc_id)
        self.add_entity(
            npc_id,
            "NPC",
            fields={
                "Presentable": {
                    "name": npc.name,
                    "description": npc.description,
                    "examine_description": npc.examine_description,
                }
            },
            metadata={
                "local_id": npc.id,
                "interactions": list(npc.interactions),
                "visible_when": list(npc.visible_when),
                "visible_unless": list(npc.visible_unless),
            },
        )
        self.assert_relation("At", [{"ref": npc_id}, {"ref": location_id}])
        self.pending_rules.append((npc_id, "npc", npc))

    def convert_ship(self, ship: Any, location_id: str) -> None:
        ship_id = safe_id(ship.id)
        self.remember_local_id(ship.id, ship_id)
        self.add_entity(
            ship_id,
            "Ship",
            fields={
                "Presentable": {"name": ship.name, "description": ship.description},
                "Vehicle": {"abilities": list(ship.abilities)},
            },
            metadata={
                "local_id": ship.id,
                "unlock": ship.unlock,
                "controlled": ship.controlled,
                "equipment_slots": list(ship.equipment_slots),
                "display_names": conditional_texts(ship.display_names),
                "interior_descriptions": conditional_texts(ship.interior_descriptions),
                "taglines": conditional_texts(ship.taglines),
                "visible_when": list(ship.visible_when),
                "visible_unless": list(ship.visible_unless),
            },
        )
        self.assert_relation("DockedAt", [{"ref": ship_id}, {"ref": location_id}])
        if ship.controlled:
            self.assert_relation("ControlledBy", [{"ref": ship_id}, {"ref": "player"}])
        self.pending_rules.append((ship_id, "ship", ship))
        for story_object in ship.objects:
            self.convert_object(story_object, ship_id)

    def attach_pending_rules(self) -> None:
        for entity_id, kind, source in self.pending_rules:
            entity = self.entity_by_id[entity_id]
            rules = entity.setdefault("rules", [])
            if kind == "destination":
                rules.append(visited_rule(source.id))
                rules.extend(before_rules(entity_id, "Enter", source.before, self.local_id_map))
                rules.extend(sequence_rules(entity_id, source.sequences, self.local_id_map))
            elif kind == "object":
                rules.extend(before_rules(entity_id, "object", source.before, self.local_id_map))
                rules.extend(use_rules(entity_id, source.use_rules, self.local_id_map))
            elif kind == "npc":
                rules.extend(before_rules(entity_id, "npc", source.before, self.local_id_map))
            elif kind == "ship":
                rules.extend(before_rules(entity_id, "ship", source.before, self.local_id_map))

    def add_entity(
        self,
        entity_id: str,
        kind: str,
        fields: dict[str, Any] | None = None,
        traits: list[dict[str, Any]] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        if entity_id in self.entity_by_id:
            raise ValueError(f"duplicate story entity {entity_id}")
        entity: dict[str, Any] = {"id": entity_id, "kind": kind}
        if traits:
            entity["traits"] = traits
        if fields:
            entity["fields"] = fields
        if metadata:
            entity["metadata"] = metadata
        self.entities.append(entity)
        self.entity_by_id[entity_id] = entity

    def assert_relation(self, relation: str, args: list[dict[str, Any]]) -> None:
        self.assertions.append({"relation": relation, "args": args})

    def remember_local_id(self, local_id: str, entity_id: str) -> None:
        self.local_id_map.setdefault(local_id, entity_id)

    def lookup_local_id(self, local_id: str) -> str:
        return self.local_id_map.get(local_id, safe_id(local_id))


def before_rules(entity_id: str, target_kind: str, rules: tuple[Any, ...], id_map: dict[str, str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for index, rule in enumerate(rules):
        action, args = action_match_for_interaction(rule.interaction, entity_id, target_kind)
        entries.append(
            {
                "id": safe_id(f"before:{rule.interaction}:{index}"),
                "phase": "before",
                "match": {"action": action, "args": args},
                "when": fact_conditions(rule.when, rule.unless, id_map),
                "effects": [{"emit": {"text": rule.message}}, *outcome_effects(rule.on_complete, id_map)],
                "control": "stop",
            }
        )
    return entries


def use_rules(entity_id: str, rules: tuple[Any, ...], id_map: dict[str, str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for index, rule in enumerate(rules):
        target_id = id_map.get(rule.target, safe_id(rule.target))
        entries.append(
            {
                "id": safe_id(f"use:{rule.target}:{index}"),
                "phase": "instead",
                "match": {
                    "action": "Use",
                    "args": {
                        "source": {"ref": entity_id},
                        "target": {"ref": target_id},
                    },
                },
                "when": fact_conditions(rule.when, rule.unless, id_map),
                "effects": [{"emit": {"text": message}} for message in rule.messages] + outcome_effects(rule.on_complete, id_map),
                "control": "stop",
            }
        )
    return entries


def sequence_rules(entity_id: str, sequences: tuple[Any, ...], id_map: dict[str, str]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for sequence in sequences:
        entries.append(
            {
                "id": safe_id(f"sequence:{sequence.id}"),
                "phase": "after",
                "match": {"action": "Enter", "args": {"destination": {"ref": entity_id}}},
                "when": fact_conditions(sequence.when, sequence.unless, id_map),
                "effects": [{"emit": {"text": message}} for message in sequence.messages] + outcome_effects(sequence.on_complete, id_map),
            }
        )
    return entries


def visited_rule(local_destination_id: str) -> dict[str, Any]:
    return {
        "id": safe_id(f"visited:{local_destination_id}"),
        "phase": "after",
        "match": {"action": "Enter", "args": {"destination": {"var": "this"}}},
        "effects": [{"set_fact": {"id": f"visited:destination:{local_destination_id}"}}],
    }


def action_match_for_interaction(interaction: str, entity_id: str, target_kind: str) -> tuple[str, dict[str, Any]]:
    if interaction == "Enter":
        return "Enter", {"destination": {"ref": entity_id}}
    if interaction == "Examine":
        return "Examine", {"target": {"ref": entity_id}}
    if interaction == "Take":
        return "Take", {"item": {"ref": entity_id}}
    if interaction == "Use":
        return "Use", {"source": {"ref": entity_id}}
    if interaction == "Power up":
        return "PowerUp", {"target": {"ref": entity_id}}
    if interaction == "Talk":
        return "Talk", {"target": {"ref": entity_id}}
    if interaction == "Board" or target_kind == "ship":
        return "Board", {"ship": {"ref": entity_id}}
    return "Examine", {"target": {"ref": entity_id}}


def fact_conditions(when: tuple[str, ...], unless: tuple[str, ...], id_map: dict[str, str]) -> Any:
    predicates: list[dict[str, Any]] = [fact_predicate(fact, id_map) for fact in when]
    predicates.extend({"not": fact_predicate(fact, id_map)} for fact in unless)
    if not predicates:
        return True
    if len(predicates) == 1:
        return predicates[0]
    return {"all": predicates}


def fact_predicate(fact: str, id_map: dict[str, str]) -> dict[str, Any]:
    parts = fact.split(":")
    if len(parts) == 4 and parts[0] == "ship" and parts[2] == "at":
        ship_id = id_map.get(parts[1], safe_id(parts[1]))
        location_id = id_map.get(parts[3], safe_id(parts[3]))
        return {"relation": {"id": "At", "args": [{"ref": ship_id}, {"ref": location_id}]}}
    if len(parts) == 3 and parts[0] == "ship" and parts[2] == "owned":
        ship_id = id_map.get(parts[1], safe_id(parts[1]))
        return {"relation": {"id": "ControlledBy", "args": [{"ref": ship_id}, {"ref": "player"}]}}
    if len(parts) == 3 and parts[0] == "ship" and parts[2] == "boarded":
        ship_id = id_map.get(parts[1], safe_id(parts[1]))
        return {"fact": {"id": "Aboard", "args": [{"ref": "player"}, {"ref": ship_id}]}}
    return {"fact": {"id": fact}}


def outcome_effects(outcomes: tuple[str, ...], id_map: dict[str, str]) -> list[dict[str, Any]]:
    effects: list[dict[str, Any]] = []
    for outcome in outcomes:
        parts = outcome.split(":")
        if len(parts) == 3 and parts[0] == "ship" and parts[2] == "control":
            ship_id = id_map.get(parts[1], safe_id(parts[1]))
            effects.append({"assert": {"relation": "ControlledBy", "args": [{"ref": ship_id}, {"ref": "player"}]}})
            effects.append({"set_fact": {"id": f"ship:{parts[1]}:owned"}})
        effects.append({"set_fact": {"id": outcome}})
    return effects


def conditional_texts(texts: tuple[Any, ...]) -> list[dict[str, Any]]:
    return [
        {
            "text": text.text,
            **({"when": list(text.when)} if text.when else {}),
            **({"unless": list(text.unless)} if text.unless else {}),
        }
        for text in texts
    ]


def safe_id(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "-", value).strip("-")
    if not cleaned:
        cleaned = "entity"
    if not re.match(r"^[A-Za-z]", cleaned):
        cleaned = "e-" + cleaned
    return cleaned


def relative_import(base: Path, target: Path) -> str:
    try:
        return str(target.resolve().relative_to(base.resolve()))
    except ValueError:
        try:
            return str(Path("../" * len(base.resolve().relative_to(PROJECT_ROOT).parts)) / target.resolve().relative_to(PROJECT_ROOT))
        except ValueError:
            return str(target.resolve())

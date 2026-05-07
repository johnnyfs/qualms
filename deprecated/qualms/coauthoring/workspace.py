from __future__ import annotations

import copy
import dataclasses
import re
import tempfile
from pathlib import Path
from typing import Any

import yaml

from qualms.yaml_loader import SchemaError, load_game_definition, read_yaml_document

from .models import (
    AssertionCreate,
    DeleteEntity,
    DestinationCreate,
    EntityUpdate,
    NpcCreate,
    PathCreate,
    ShipCreate,
    StoryObjectCreate,
    ToolResult,
)


ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]*$")
LEGACY_DESTINATION_KINDS = {"Bar", "Destination", "Tourist Destination"}
LEGACY_OBJECT_INTERACTIONS = {"Examine", "Power up", "Take", "Use"}
LEGACY_NPC_INTERACTIONS = {"Examine", "Talk"}


class CoauthorWorkspace:
    """Mutable top-level story document exposed through typed coauthor tools."""

    def __init__(self, path: str | Path):
        self.path = Path(path).resolve()
        self.raw = read_yaml_document(self.path)
        self._ensure_story()

    def snapshot(self) -> dict[str, Any]:
        return copy.deepcopy(self.raw)

    def rollback(self, snapshot: dict[str, Any]) -> None:
        self.raw = copy.deepcopy(snapshot)
        self._ensure_story()

    def save(self) -> None:
        self.path.write_text(yaml.safe_dump(self.raw, sort_keys=False, allow_unicode=False), encoding="utf-8")

    def validate(self) -> ToolResult:
        try:
            definition = self._load_candidate_definition()
            self._validate_legacy_metadata()
        except (OSError, SchemaError, ValueError, KeyError) as error:
            return ToolResult(ok=False, message=f"Validation failed: {error}")
        return ToolResult(
            message="Validation succeeded.",
            data={
                "entities": len(definition.initial_entities),
                "assertions": len(definition.initial_assertions),
                "rules": len(definition.rules),
            },
        )

    def list_entities(
        self,
        kind: str | None = None,
        parent: str | None = None,
        with_trait: str | None = None,
        name_contains: str | None = None,
        editable_only: bool = False,
    ) -> ToolResult:
        definition = load_game_definition(self.path) if self.raw == read_yaml_document(self.path) else self._compile_candidate()
        editable_ids = set(self.top_entity_by_id())
        at_locations = self._at_locations(definition.initial_assertions)
        name_needle = name_contains.lower() if name_contains else None
        rows = []
        for spec in definition.initial_entities:
            traits = self._spec_trait_ids(definition, spec)
            name = self._presentable(spec).get("name") or spec.metadata.get("local_id") or spec.id
            if kind and spec.kind != kind:
                continue
            if parent and at_locations.get(spec.id) != parent:
                continue
            if with_trait and with_trait not in traits:
                continue
            if name_needle and name_needle not in str(name).lower():
                continue
            if editable_only and spec.id not in editable_ids:
                continue
            rows.append(
                {
                    "id": spec.id,
                    "kind": spec.kind,
                    "name": name,
                    "traits": sorted(traits),
                    "parent": at_locations.get(spec.id),
                    "editable": spec.id in editable_ids,
                }
            )
        return ToolResult(message=f"Found {len(rows)} entities.", data=rows)

    def get_entity(self, entity_id: str) -> ToolResult:
        definition = self._compile_candidate()
        editable = self.top_entity_by_id().get(entity_id)
        for spec in definition.initial_entities:
            if spec.id != entity_id:
                continue
            data = self._dataclass_data(spec)
            data["editable"] = editable is not None
            if editable is not None:
                data["top_level_raw"] = copy.deepcopy(editable)
            return ToolResult(message=f"Found entity {entity_id}.", data=data)
        return ToolResult(ok=False, message=f"Unknown entity: {entity_id}")

    def create_destination(self, value: DestinationCreate) -> ToolResult:
        self._require_location(value.parent_id)
        entity_id = self._child_id(value.parent_id, value.id)
        self._require_new_entity(entity_id)
        display_kind = value.display_kind if value.display_kind in LEGACY_DESTINATION_KINDS else "Destination"
        port = value.port or value.display_kind.lower() == "port"
        entity = {
            "id": entity_id,
            "kind": "Destination",
            **({"traits": [{"id": "Port"}]} if port else {}),
            "fields": {"Presentable": {"name": value.name, "description": value.description}},
            "metadata": {
                "local_id": self._local_id(entity_id),
                "display_kind": display_kind,
                "port": port,
                "visible_when": list(value.visible_when),
                "visible_unless": list(value.visible_unless),
            },
            "rules": [],
        }
        self.entities.append(entity)
        self._remember_local_id(entity["metadata"]["local_id"], entity_id)
        self._append_assertion("At", [entity_id, value.parent_id])
        return ToolResult(message=f"Created destination {entity_id}.", data=copy.deepcopy(entity))

    def create_object(self, value: StoryObjectCreate) -> ToolResult:
        self._require_location(value.location_id)
        entity_id = self._child_id(f"{value.location_id}:object", value.id)
        self._require_new_entity(entity_id)
        traits: list[dict[str, Any]] = []
        if value.collectable:
            traits.append({"id": "Portable"})
        if value.equipment_slot:
            traits.append({"id": "Equipment", "fields": {"slot": value.equipment_slot}})
        if value.fuel_station:
            traits.append({"id": "FuelStation"})
        interactions = self._validated_interactions(
            value.interactions or ["Examine"],
            LEGACY_OBJECT_INTERACTIONS,
            f"{entity_id}.metadata.interactions",
        )
        if "Use" in interactions:
            traits.append({"id": "Usable"})
        entity = {
            "id": entity_id,
            "kind": "StoryObject",
            **({"traits": traits} if traits else {}),
            "fields": {"Presentable": {"name": value.name, "description": value.description}},
            "metadata": {
                "local_id": self._local_id(entity_id),
                "interactions": interactions,
                "collectable": value.collectable,
                **({"fuel_station": True} if value.fuel_station else {}),
                "visible_when": list(value.visible_when),
                "visible_unless": list(value.visible_unless),
            },
            "rules": [],
        }
        self.entities.append(entity)
        self._remember_local_id(entity["metadata"]["local_id"], entity_id)
        self._append_assertion("At", [entity_id, value.location_id])
        return ToolResult(message=f"Created object {entity_id}.", data=copy.deepcopy(entity))

    def create_npc(self, value: NpcCreate) -> ToolResult:
        self._require_location(value.location_id)
        entity_id = self._child_id(f"{value.location_id}:npc", value.id)
        self._require_new_entity(entity_id)
        entity = {
            "id": entity_id,
            "kind": "NPC",
            "fields": {
                "Presentable": {
                    "name": value.name,
                    "description": value.description,
                    "examine_description": value.examine_description or value.description,
                }
            },
            "metadata": {
                "local_id": self._local_id(entity_id),
                "interactions": value.interactions or ["Examine", "Talk"],
                "visible_when": list(value.visible_when),
                "visible_unless": list(value.visible_unless),
            },
            "rules": [],
        }
        self.entities.append(entity)
        self._remember_local_id(entity["metadata"]["local_id"], entity_id)
        self._append_assertion("At", [entity_id, value.location_id])
        return ToolResult(message=f"Created NPC {entity_id}.", data=copy.deepcopy(entity))

    def create_ship(self, value: ShipCreate) -> ToolResult:
        if value.docked_at_id:
            self._require_location(value.docked_at_id)
        if value.at_id:
            self._require_location(value.at_id)
        entity_id = self._top_level_id(value.id)
        self._require_new_entity(entity_id)
        entity = {
            "id": entity_id,
            "kind": "Ship",
            "fields": {
                "Presentable": {"name": value.name, "description": value.description},
                "Vehicle": {"abilities": list(value.abilities)},
            },
            "metadata": {
                "local_id": self._local_id(entity_id),
                "unlock": value.unlock,
                "controlled": bool(value.controlled_by_actor_id),
                "equipment_slots": list(value.equipment_slots),
                "visible_when": list(value.visible_when),
                "visible_unless": list(value.visible_unless),
            },
        }
        self.entities.append(entity)
        self._remember_local_id(entity["metadata"]["local_id"], entity_id)
        if value.docked_at_id:
            self._append_assertion("DockedAt", [entity_id, value.docked_at_id])
        elif value.at_id:
            self._append_assertion("At", [entity_id, value.at_id])
        if value.controlled_by_actor_id:
            self._append_assertion("ControlledBy", [entity_id, value.controlled_by_actor_id])
        return ToolResult(message=f"Created ship {entity_id}.", data=copy.deepcopy(entity))

    def connect_path(self, value: PathCreate) -> ToolResult:
        self._require_location(value.source_id)
        self._require_location(value.target_id)
        created = []
        pairs = [(value.source_id, value.target_id)]
        if value.bidirectional:
            pairs.append((value.target_id, value.source_id))
        for source, target in pairs:
            if not self._has_assertion("Path", [source, target]):
                self._append_assertion("Path", [source, target])
                created.append([source, target])
        return ToolResult(message=f"Created {len(created)} Path assertion(s).", data=created)

    def create_assertion(self, value: AssertionCreate) -> ToolResult:
        self._append_assertion(value.relation, list(value.refs))
        return ToolResult(message=f"Created {value.relation} assertion.", data=self.assertions[-1])

    def update_entity(self, value: EntityUpdate) -> ToolResult:
        entity = self.top_entity_by_id().get(value.id)
        if entity is None:
            return ToolResult(ok=False, message=f"{value.id} is not an editable top-level entity.")
        if value.kind is not None:
            entity["kind"] = value.kind
        if value.presentable is not None:
            fields = entity.setdefault("fields", {}).setdefault("Presentable", {})
            patch = value.presentable.model_dump(exclude_none=True)
            fields.update(patch)
        for trait_id, field_values in value.fields_merge.items():
            entity.setdefault("fields", {}).setdefault(trait_id, {}).update(copy.deepcopy(field_values))
        if value.metadata_merge:
            metadata_patch = copy.deepcopy(value.metadata_merge)
            if "interactions" in metadata_patch:
                if entity.get("kind") == "StoryObject":
                    metadata_patch["interactions"] = self._validated_interactions(
                        metadata_patch["interactions"],
                        LEGACY_OBJECT_INTERACTIONS,
                        f"{value.id}.metadata.interactions",
                    )
                elif entity.get("kind") == "NPC":
                    metadata_patch["interactions"] = self._validated_interactions(
                        metadata_patch["interactions"],
                        LEGACY_NPC_INTERACTIONS,
                        f"{value.id}.metadata.interactions",
                    )
            entity.setdefault("metadata", {}).update(metadata_patch)
            local_id = entity["metadata"].get("local_id")
            if isinstance(local_id, str):
                self._remember_local_id(local_id, value.id)
        self._remove_traits(entity, value.traits_remove)
        self._add_traits(entity, value.traits_add)
        if value.rules_replace is not None:
            entity["rules"] = copy.deepcopy(value.rules_replace)
        return ToolResult(message=f"Updated entity {value.id}.", data=copy.deepcopy(entity))

    def delete_entity(self, value: DeleteEntity) -> ToolResult:
        index = next((idx for idx, entity in enumerate(self.entities) if entity.get("id") == value.id), None)
        if index is None:
            return ToolResult(ok=False, message=f"{value.id} is not an editable top-level entity.")
        references = self.find_references(value.id)
        direct_assertions = [ref for ref in references if ref.get("section") == "story.assertions"]
        other_references = [ref for ref in references if ref.get("section") != "story.assertions"]
        if other_references or (direct_assertions and not value.cascade_assertions):
            return ToolResult(
                ok=False,
                message=f"Refusing to delete {value.id}; references remain.",
                data=references,
            )
        del self.entities[index]
        if value.cascade_assertions:
            self.story["assertions"] = [
                assertion for assertion in self.assertions if value.id not in self._assertion_refs(assertion)
            ]
        return ToolResult(message=f"Deleted entity {value.id}.", data={"references_removed": len(direct_assertions)})

    def find_references(self, entity_id: str) -> list[dict[str, Any]]:
        references: list[dict[str, Any]] = []
        for index, assertion in enumerate(self.assertions):
            if entity_id in self._assertion_refs(assertion):
                references.append({"section": "story.assertions", "index": index, "assertion": copy.deepcopy(assertion)})
        for entity in self.entities:
            if entity.get("id") == entity_id:
                continue
            paths = []
            self._collect_refs(entity, entity_id, [], paths)
            for path in paths:
                references.append({"section": "story.entities", "entity": entity.get("id"), "path": path})
        return references

    def list_definitions(self, definition_type: str) -> ToolResult:
        definition = self._compile_candidate()
        if definition_type == "trait":
            data = [
                {"id": item.id, "fields": [field.id for field in item.fields]}
                for item in definition.traits.values()
            ]
        elif definition_type == "kind":
            data = [
                {"id": item.id, "traits": [trait.id for trait in item.traits]}
                for item in definition.kinds.values()
            ]
        elif definition_type == "relation":
            data = [
                {"id": item.id, "params": [param.id for param in item.parameters], "writable": item.can_assert()}
                for item in definition.relations.values()
            ]
        elif definition_type == "action":
            data = [
                {"id": item.id, "params": [param.id for param in item.parameters]}
                for item in definition.actions.values()
            ]
        elif definition_type == "rule":
            data = [
                {"id": item.id, "phase": item.phase, "action": item.pattern.action}
                for item in definition.rules
            ]
        else:
            return ToolResult(ok=False, message="definition_type must be trait, kind, relation, action, or rule.")
        return ToolResult(message=f"Found {len(data)} {definition_type} definitions.", data=data)

    def get_definition(self, definition_type: str, definition_id: str) -> ToolResult:
        definition = self._compile_candidate()
        collections = {
            "trait": definition.traits,
            "kind": definition.kinds,
            "relation": definition.relations,
            "action": definition.actions,
        }
        if definition_type == "rule":
            for rule in definition.rules:
                if rule.id == definition_id:
                    return ToolResult(message=f"Found rule {definition_id}.", data=self._dataclass_data(rule))
            return ToolResult(ok=False, message=f"Unknown rule: {definition_id}")
        collection = collections.get(definition_type)
        if collection is None:
            return ToolResult(ok=False, message="definition_type must be trait, kind, relation, action, or rule.")
        item = collection.get(definition_id)
        if item is None:
            return ToolResult(ok=False, message=f"Unknown {definition_type}: {definition_id}")
        return ToolResult(message=f"Found {definition_type} {definition_id}.", data=self._dataclass_data(item))

    @property
    def story(self) -> dict[str, Any]:
        return self.raw["story"]

    @property
    def entities(self) -> list[dict[str, Any]]:
        return self.story["entities"]

    @property
    def assertions(self) -> list[dict[str, Any]]:
        return self.story["assertions"]

    def top_entity_by_id(self) -> dict[str, dict[str, Any]]:
        return {str(entity.get("id")): entity for entity in self.entities if isinstance(entity, dict)}

    def _compile_candidate(self) -> Any:
        return self._load_candidate_definition()

    def _load_candidate_definition(self) -> Any:
        candidate_path: Path | None = None
        with tempfile.NamedTemporaryFile(
            "w",
            dir=self.path.parent,
            prefix=f".{self.path.stem}.",
            suffix=".qualms.yaml",
            delete=False,
            encoding="utf-8",
        ) as candidate:
            candidate_path = Path(candidate.name)
            yaml.safe_dump(self.raw, candidate, sort_keys=False, allow_unicode=False)
        try:
            return load_game_definition(candidate_path)
        finally:
            if candidate_path is not None:
                try:
                    candidate_path.unlink()
                except FileNotFoundError:
                    pass

    def _validate_legacy_metadata(self) -> None:
        for entity in self.entities:
            if not isinstance(entity, dict):
                continue
            kind = entity.get("kind")
            metadata = entity.get("metadata", {})
            if not isinstance(metadata, dict):
                continue
            entity_id = str(entity.get("id", "<unknown>"))
            if kind == "Destination":
                display_kind = metadata.get("display_kind", "Destination")
                if display_kind not in LEGACY_DESTINATION_KINDS:
                    raise ValueError(
                        f"{entity_id}.metadata.display_kind must be one of {sorted(LEGACY_DESTINATION_KINDS)}"
                    )
            if kind == "StoryObject" and "interactions" in metadata:
                self._validated_interactions(
                    metadata["interactions"],
                    LEGACY_OBJECT_INTERACTIONS,
                    f"{entity_id}.metadata.interactions",
                )
            if kind == "NPC" and "interactions" in metadata:
                self._validated_interactions(
                    metadata["interactions"],
                    LEGACY_NPC_INTERACTIONS,
                    f"{entity_id}.metadata.interactions",
                )

    def _validated_interactions(self, raw: Any, allowed: set[str], context: str) -> list[str]:
        if not isinstance(raw, list):
            raise ValueError(f"{context} must be a list")
        if not raw:
            raise ValueError(f"{context} must not be empty")
        interactions: list[str] = []
        for index, value in enumerate(raw):
            if not isinstance(value, str) or not value:
                raise ValueError(f"{context}[{index}] must be a non-empty string")
            if value not in allowed:
                raise ValueError(f"{context}[{index}] must be one of {sorted(allowed)}")
            if value not in interactions:
                interactions.append(value)
        return interactions

    def _ensure_story(self) -> None:
        story = self.raw.setdefault("story", {})
        if not isinstance(story, dict):
            raise ValueError("story must be a mapping")
        story.setdefault("entities", [])
        story.setdefault("assertions", [])
        story.setdefault("facts", [])
        if not isinstance(story["entities"], list) or not isinstance(story["assertions"], list):
            raise ValueError("story.entities and story.assertions must be lists")

    def _require_new_entity(self, entity_id: str) -> None:
        if not ID_RE.match(entity_id):
            raise ValueError(f"invalid entity id: {entity_id}")
        if entity_id in self.top_entity_by_id():
            raise ValueError(f"duplicate top-level entity: {entity_id}")
        definition = self._compile_candidate()
        if any(spec.id == entity_id for spec in definition.initial_entities):
            raise ValueError(f"entity already exists in compiled story: {entity_id}")

    def _require_location(self, entity_id: str) -> None:
        definition = self._compile_candidate()
        for spec in definition.initial_entities:
            if spec.id != entity_id:
                continue
            if "Location" not in self._spec_trait_ids(definition, spec):
                raise ValueError(f"{entity_id} is not a Location")
            return
        raise ValueError(f"unknown location: {entity_id}")

    def _append_assertion(self, relation: str, refs: list[str]) -> None:
        self.assertions.append({"relation": relation, "args": [{"ref": ref} for ref in refs]})

    def _has_assertion(self, relation: str, refs: list[str]) -> bool:
        return any(assertion.get("relation") == relation and self._assertion_refs(assertion) == refs for assertion in self.assertions)

    def _assertion_refs(self, assertion: dict[str, Any]) -> list[str]:
        return [
            str(arg["ref"])
            for arg in assertion.get("args", [])
            if isinstance(arg, dict) and isinstance(arg.get("ref"), str)
        ]

    def _remember_local_id(self, local_id: str, entity_id: str) -> None:
        metadata = self.raw.setdefault("metadata", {})
        if not isinstance(metadata, dict):
            raise ValueError("metadata must be a mapping")
        local_id_map = metadata.setdefault("local_id_map", {})
        if isinstance(local_id_map, dict):
            local_id_map.setdefault(local_id, entity_id)

    def _child_id(self, parent_id: str, value: str) -> str:
        return value if ":" in value else f"{parent_id}:{value}"

    def _top_level_id(self, value: str) -> str:
        return value

    def _local_id(self, entity_id: str) -> str:
        return entity_id.rsplit(":", 1)[-1]

    def _remove_traits(self, entity: dict[str, Any], trait_ids: list[str]) -> None:
        if not trait_ids:
            return
        traits = entity.get("traits", [])
        if not isinstance(traits, list):
            return
        remove = set(trait_ids)
        entity["traits"] = [trait for trait in traits if self._trait_id(trait) not in remove]

    def _add_traits(self, entity: dict[str, Any], traits: list[Any]) -> None:
        if not traits:
            return
        existing = {self._trait_id(trait): index for index, trait in enumerate(entity.get("traits", [])) if self._trait_id(trait)}
        raw_traits = list(entity.get("traits", []))
        for trait in traits:
            raw = trait.model_dump(exclude_none=True)
            trait_id = raw["id"]
            if trait_id in existing:
                raw_traits[existing[trait_id]] = raw
            else:
                existing[trait_id] = len(raw_traits)
                raw_traits.append(raw)
        entity["traits"] = raw_traits

    def _trait_id(self, trait: Any) -> str | None:
        if isinstance(trait, str):
            return trait
        if isinstance(trait, dict) and isinstance(trait.get("id"), str):
            return trait["id"]
        return None

    def _at_locations(self, assertions: Any) -> dict[str, str]:
        locations: dict[str, str] = {}
        for assertion in assertions:
            if assertion.get("relation") != "At":
                continue
            refs = self._assertion_refs(assertion)
            if len(refs) == 2:
                locations[refs[0]] = refs[1]
        return locations

    def _spec_trait_ids(self, definition: Any, spec: Any) -> set[str]:
        traits = {attachment.id for attachment in spec.traits}
        if spec.kind:
            traits.update(attachment.id for attachment in definition.kind(spec.kind).traits)
        return traits

    def _presentable(self, spec: Any) -> dict[str, Any]:
        fields = copy.deepcopy(spec.fields.get("Presentable", {}))
        for attachment in spec.traits:
            if attachment.id == "Presentable":
                fields = {**attachment.fields, **fields}
        return fields

    def _collect_refs(self, value: Any, entity_id: str, path: list[str], matches: list[str]) -> None:
        if isinstance(value, dict):
            if value.get("ref") == entity_id:
                matches.append(".".join(path + ["ref"]))
            for key, child in value.items():
                self._collect_refs(child, entity_id, path + [str(key)], matches)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                self._collect_refs(child, entity_id, path + [str(index)], matches)
        elif value == entity_id:
            matches.append(".".join(path))

    def _dataclass_data(self, value: Any) -> Any:
        if dataclasses.is_dataclass(value):
            return sanitize(dataclasses.asdict(value))
        if isinstance(value, dict):
            return sanitize(copy.deepcopy(value))
        return sanitize(value)


def sanitize(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): sanitize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return repr(value)

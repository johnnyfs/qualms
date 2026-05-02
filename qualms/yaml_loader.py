from __future__ import annotations

import copy
import re
from pathlib import Path
from typing import Any

import yaml

from .core import (
    ActionDefinition,
    ActionPattern,
    EntitySpec,
    FieldDefinition,
    GameDefinition,
    KindDefinition,
    MISSING,
    ParameterDefinition,
    RelationDefinition,
    Rule,
    TraitAttachment,
    TraitDefinition,
)


SCHEMA_VERSION = "0.1"
ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]*$")


class SchemaError(ValueError):
    pass


def load_game_definition(path: str | Path) -> GameDefinition:
    loader = YamlGameLoader()
    return loader.load(Path(path))


def load_world_state(path: str | Path):
    return load_game_definition(path).instantiate()


class YamlGameLoader:
    def __init__(self) -> None:
        self._loading: list[Path] = []

    def load(self, path: Path) -> GameDefinition:
        path = path.resolve()
        docs = self._load_with_imports(path)
        return compile_documents(docs)

    def _load_with_imports(self, path: Path) -> list[dict[str, Any]]:
        if path in self._loading:
            cycle = " -> ".join(str(item) for item in (*self._loading, path))
            raise SchemaError(f"import cycle: {cycle}")
        self._loading.append(path)
        raw = read_yaml_document(path)
        imports = require_list(raw, "imports", str(path), default=[])
        docs: list[dict[str, Any]] = []
        for index, import_ref in enumerate(imports):
            if not isinstance(import_ref, str) or not import_ref.strip():
                raise SchemaError(f"{path}.imports[{index}] must be a non-empty string")
            import_path = (path.parent / import_ref).resolve()
            docs.extend(self._load_with_imports(import_path))
        docs.append(raw)
        self._loading.pop()
        return docs


def read_yaml_document(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SchemaError(f"YAML file does not exist: {path}")
    loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise SchemaError(f"{path} root must be a mapping")
    version = loaded.get("qualms")
    if version != SCHEMA_VERSION:
        raise SchemaError(f"{path}.qualms must be {SCHEMA_VERSION!r}")
    require_id(loaded.get("id"), f"{path}.id")
    return loaded


def compile_documents(docs: list[dict[str, Any]]) -> GameDefinition:
    trait_defs: dict[str, TraitDefinition] = {}
    relation_defs: dict[str, RelationDefinition] = {}
    action_defs: dict[str, ActionDefinition] = {}
    kind_defs: dict[str, KindDefinition] = {}
    rules: list[Rule] = []
    entity_specs: list[EntitySpec] = []
    initial_assertions: list[dict[str, Any]] = []
    initial_facts: list[dict[str, Any]] = []
    metadata: dict[str, Any] = {"documents": [doc["id"] for doc in docs]}
    rule_order = 0

    for doc in docs:
        context = doc["id"]
        if "metadata" in doc:
            metadata.update(copy.deepcopy(require_mapping(doc, "metadata", context, default={})))
        definitions = require_mapping(doc, "definitions", context, default={})
        for raw_trait in require_list(definitions, "traits", f"{context}.definitions", default=[]):
            trait = parse_trait(raw_trait, f"{context}.definitions.traits")
            ensure_unique(trait_defs, trait.id, f"trait {trait.id}")
            trait_defs[trait.id] = trait
        for raw_relation in require_list(definitions, "relations", f"{context}.definitions", default=[]):
            relation = parse_relation(raw_relation, f"{context}.definitions.relations")
            ensure_unique(relation_defs, relation.id, f"relation {relation.id}")
            relation_defs[relation.id] = relation
        for raw_action in require_list(definitions, "actions", f"{context}.definitions", default=[]):
            action = parse_action(raw_action, f"{context}.definitions.actions")
            ensure_unique(action_defs, action.id, f"action {action.id}")
            action_defs[action.id] = action
        for raw_kind in require_list(definitions, "kinds", f"{context}.definitions", default=[]):
            kind = parse_kind(raw_kind, f"{context}.definitions.kinds")
            ensure_unique(kind_defs, kind.id, f"kind {kind.id}")
            kind_defs[kind.id] = kind
        for raw_rulebook in require_list(definitions, "rulebooks", f"{context}.definitions", default=[]):
            parsed_rules, rule_order = parse_rulebook(raw_rulebook, f"{context}.definitions.rulebooks", rule_order)
            rules.extend(parsed_rules)

    for doc in docs:
        context = doc["id"]
        story = require_mapping(doc, "story", context, default={})
        if "start" in story:
            metadata["start"] = copy.deepcopy(story["start"])
        for raw_entity in require_list(story, "entities", f"{context}.story", default=[]):
            entity_spec = parse_entity(raw_entity, f"{context}.story.entities")
            ensure_unique({entity.id: entity for entity in entity_specs}, entity_spec.id, f"entity {entity_spec.id}")
            entity_specs.append(entity_spec)
        initial_assertions.extend(copy.deepcopy(require_list(story, "assertions", f"{context}.story", default=[])))
        initial_facts.extend(copy.deepcopy(require_list(story, "facts", f"{context}.story", default=[])))

    validate_definitions(trait_defs, relation_defs, action_defs, kind_defs)
    definition = GameDefinition(
        traits=trait_defs,
        relations=relation_defs,
        actions=action_defs,
        rules=tuple(assign_rule_orders(rules)),
        kinds=kind_defs,
        initial_entities=tuple(entity_specs),
        initial_assertions=tuple(initial_assertions),
        initial_facts=tuple(initial_facts),
        metadata=metadata,
    )
    validate_story(definition)
    definition = with_entity_and_kind_rules(definition)
    validate_rules(definition)
    return definition


def with_entity_and_kind_rules(definition: GameDefinition) -> GameDefinition:
    rules = list(definition.rules)
    order = len(rules)
    for spec in definition.initial_entities:
        local_rules: list[Rule] = []
        if spec.kind:
            local_rules.extend(definition.kind(spec.kind).rules)
        local_rules.extend(spec.rules)
        for rule in local_rules:
            rules.append(rewrite_rule_this(rule, spec.id, order))
            order += 1
    return GameDefinition(
        traits=definition.traits,
        relations=definition.relations,
        actions=definition.actions,
        rules=tuple(rules),
        kinds=definition.kinds,
        initial_entities=definition.initial_entities,
        initial_assertions=definition.initial_assertions,
        initial_facts=definition.initial_facts,
        metadata=definition.metadata,
    )


def parse_trait(raw: Any, context: str) -> TraitDefinition:
    mapping = require_mapping_value(raw, context)
    trait_id = require_id(mapping.get("id"), f"{context}.id")
    return TraitDefinition(
        id=trait_id,
        parameters=tuple(parse_parameters(mapping.get("params", []), f"{context}.{trait_id}.params")),
        fields=tuple(parse_field(raw_field, f"{context}.{trait_id}.fields") for raw_field in require_list(mapping, "fields", context, default=[])),
        relations=tuple(parse_relation(raw_relation, f"{context}.{trait_id}.relations") for raw_relation in require_list(mapping, "relations", context, default=[])),
        actions=tuple(parse_action(raw_action, f"{context}.{trait_id}.actions") for raw_action in require_list(mapping, "actions", context, default=[])),
        rules=tuple(parse_rule(raw_rule, f"{context}.{trait_id}.rules", index) for index, raw_rule in enumerate(require_list(mapping, "rules", context, default=[]))),
        constraints=tuple(copy.deepcopy(require_list(mapping, "constraints", context, default=[]))),
    )


def parse_parameters(raw_values: Any, context: str) -> list[ParameterDefinition]:
    values = raw_values or []
    if not isinstance(values, list):
        raise SchemaError(f"{context} must be a list")
    parameters: list[ParameterDefinition] = []
    seen: set[str] = set()
    for index, raw in enumerate(values):
        mapping = require_mapping_value(raw, f"{context}[{index}]")
        param_id = require_id(mapping.get("id"), f"{context}[{index}].id")
        if param_id in seen:
            raise SchemaError(f"{context}[{index}].id duplicates {param_id}")
        seen.add(param_id)
        parameters.append(ParameterDefinition(param_id, require_string(mapping.get("type", "value"), f"{context}[{index}].type"), default_value(mapping)))
    return parameters


def parse_field(raw: Any, context: str) -> FieldDefinition:
    mapping = require_mapping_value(raw, context)
    field_id = require_id(mapping.get("id"), f"{context}.id")
    return FieldDefinition(
        id=field_id,
        type=require_string(mapping.get("type", "value"), f"{context}.{field_id}.type"),
        default=default_value(mapping),
    )


def parse_relation(raw: Any, context: str) -> RelationDefinition:
    mapping = require_mapping_value(raw, context)
    relation_id = require_id(mapping.get("id"), f"{context}.id")
    if "get" not in mapping:
        raise SchemaError(f"{context}.{relation_id}.get is required")
    set_effects = mapping.get("set")
    if set_effects is not None and not isinstance(set_effects, list):
        raise SchemaError(f"{context}.{relation_id}.set must be a list")
    return RelationDefinition(
        id=relation_id,
        parameters=tuple(parse_parameters(mapping.get("params", []), f"{context}.{relation_id}.params")),
        get=copy.deepcopy(mapping["get"]),
        set_effects=tuple(copy.deepcopy(set_effects)) if set_effects is not None else None,
    )


def parse_action(raw: Any, context: str) -> ActionDefinition:
    mapping = require_mapping_value(raw, context)
    action_id = require_id(mapping.get("id"), f"{context}.id")
    default = mapping.get("default", [])
    if not isinstance(default, list):
        raise SchemaError(f"{context}.{action_id}.default must be a list")
    return ActionDefinition(
        id=action_id,
        parameters=tuple(parse_parameters(mapping.get("params", []), f"{context}.{action_id}.params")),
        requires=copy.deepcopy(mapping.get("requires", True)),
        default_effects=tuple(copy.deepcopy(default)),
    )


def parse_kind(raw: Any, context: str) -> KindDefinition:
    mapping = require_mapping_value(raw, context)
    kind_id = require_id(mapping.get("id"), f"{context}.id")
    return KindDefinition(
        id=kind_id,
        traits=tuple(parse_trait_attachment(item, f"{context}.{kind_id}.traits") for item in require_list(mapping, "traits", context, default=[])),
        fields=copy.deepcopy(require_mapping(mapping, "fields", context, default={})),
        rules=tuple(parse_rule(raw_rule, f"{context}.{kind_id}.rules", index) for index, raw_rule in enumerate(require_list(mapping, "rules", context, default=[]))),
    )


def parse_rulebook(raw: Any, context: str, start_order: int) -> tuple[list[Rule], int]:
    mapping = require_mapping_value(raw, context)
    rulebook_id = require_id(mapping.get("id"), f"{context}.id")
    guard = copy.deepcopy(mapping.get("when", True))
    rules: list[Rule] = []
    order = start_order
    for index, raw_rule in enumerate(require_list(mapping, "rules", context, default=[])):
        rule = parse_rule(raw_rule, f"{context}.{rulebook_id}.rules[{index}]", order)
        rules.append(
            Rule(
                id=f"{rulebook_id}.{rule.id}",
                phase=rule.phase,
                pattern=rule.pattern,
                effects=rule.effects,
                guard=combine_guards(guard, rule.guard),
                control=rule.control,
                priority=rule.priority,
                order=order,
            )
        )
        order += 1
    return rules, order


def parse_rule(raw: Any, context: str, order: int) -> Rule:
    mapping = require_mapping_value(raw, context)
    rule_id = require_id(mapping.get("id"), f"{context}.id")
    phase = require_string(mapping.get("phase"), f"{context}.{rule_id}.phase")
    if phase not in {"before", "instead", "after"}:
        raise SchemaError(f"{context}.{rule_id}.phase must be before, instead, or after")
    match = require_mapping_value(mapping.get("match"), f"{context}.{rule_id}.match")
    action = require_id(match.get("action"), f"{context}.{rule_id}.match.action")
    guard = copy.deepcopy(mapping.get("when", True))
    if "unless" in mapping:
        guard = combine_guards(guard, {"not": copy.deepcopy(mapping["unless"])})
    effects = require_list(mapping, "effects", context, default=[])
    control = mapping.get("control", "continue")
    if control not in {"continue", "stop"}:
        raise SchemaError(f"{context}.{rule_id}.control must be continue or stop")
    return Rule(
        id=rule_id,
        phase=phase,
        pattern=ActionPattern(action, copy.deepcopy(match.get("args", {}))),
        effects=tuple(copy.deepcopy(effects)),
        guard=guard,
        control=control,
        priority=int(mapping.get("priority", 0)),
        order=order,
    )


def parse_entity(raw: Any, context: str) -> EntitySpec:
    mapping = require_mapping_value(raw, context)
    entity_id = require_id(mapping.get("id"), f"{context}.id")
    kind = mapping.get("kind")
    if kind is not None:
        kind = require_id(kind, f"{context}.{entity_id}.kind")
    return EntitySpec(
        id=entity_id,
        kind=kind,
        traits=tuple(parse_trait_attachment(item, f"{context}.{entity_id}.traits") for item in require_list(mapping, "traits", context, default=[])),
        fields=copy.deepcopy(require_mapping(mapping, "fields", context, default={})),
        rules=tuple(parse_rule(raw_rule, f"{context}.{entity_id}.rules", index) for index, raw_rule in enumerate(require_list(mapping, "rules", context, default=[]))),
        metadata=copy.deepcopy(require_mapping(mapping, "metadata", context, default={})),
    )


def parse_trait_attachment(raw: Any, context: str) -> TraitAttachment:
    if isinstance(raw, str):
        return TraitAttachment(require_id(raw, context))
    mapping = require_mapping_value(raw, context)
    trait_id = require_id(mapping.get("id"), f"{context}.id")
    return TraitAttachment(
        id=trait_id,
        parameters=copy.deepcopy(mapping.get("params", mapping.get("parameters", {}))),
        fields=copy.deepcopy(mapping.get("fields", {})),
    )


def validate_definitions(
    traits: dict[str, TraitDefinition],
    relations: dict[str, RelationDefinition],
    actions: dict[str, ActionDefinition],
    kinds: dict[str, KindDefinition],
) -> None:
    all_relations = dict(relations)
    all_actions = dict(actions)
    for trait in traits.values():
        validate_unique([field.id for field in trait.fields], f"{trait.id}.fields")
        validate_types([field.type for field in trait.fields], traits)
        for relation in trait.relations:
            ensure_unique(all_relations, relation.id, f"relation {relation.id}")
            all_relations[relation.id] = relation
        for action in trait.actions:
            ensure_unique(all_actions, action.id, f"action {action.id}")
            all_actions[action.id] = action
    for relation in all_relations.values():
        validate_unique([param.id for param in relation.parameters], f"{relation.id}.params")
        validate_types([param.type for param in relation.parameters], traits)
    for action in all_actions.values():
        validate_unique([param.id for param in action.parameters], f"{action.id}.params")
        validate_types([param.type for param in action.parameters], traits)
    for kind in kinds.values():
        for attachment in kind.traits:
            if attachment.id not in traits:
                raise SchemaError(f"kind {kind.id} references unknown trait {attachment.id}")
            validate_trait_fields(traits[attachment.id], attachment.fields, f"kind {kind.id}.{attachment.id}")
        for trait_id, fields in kind.fields.items():
            if trait_id not in traits:
                raise SchemaError(f"kind {kind.id}.fields references unknown trait {trait_id}")
            validate_trait_fields(traits[trait_id], fields, f"kind {kind.id}.fields.{trait_id}")


def validate_story(definition: GameDefinition) -> None:
    seen: set[str] = set()
    for spec in definition.initial_entities:
        if spec.id in seen:
            raise SchemaError(f"duplicate entity {spec.id}")
        seen.add(spec.id)
        if spec.kind and spec.kind not in definition.kinds:
            raise SchemaError(f"entity {spec.id} references unknown kind {spec.kind}")
        final_traits = {attachment.id: attachment for attachment in spec.traits}
        if spec.kind:
            final_traits.update({attachment.id: attachment for attachment in definition.kind(spec.kind).traits})
        for attachment in spec.traits:
            if attachment.id not in definition.traits:
                raise SchemaError(f"entity {spec.id} references unknown trait {attachment.id}")
            validate_trait_fields(definition.trait(attachment.id), attachment.fields, f"entity {spec.id}.{attachment.id}")
        for trait_id, fields in spec.fields.items():
            if trait_id not in final_traits:
                raise SchemaError(f"entity {spec.id}.fields references missing trait {trait_id}")
            validate_trait_fields(definition.trait(trait_id), fields, f"entity {spec.id}.fields.{trait_id}")
    for assertion in definition.initial_assertions:
        relation_id = assertion.get("relation")
        if relation_id not in definition.relations:
            raise SchemaError(f"initial assertion references unknown relation {relation_id}")
        if not definition.relation(relation_id).can_assert():
            raise SchemaError(f"initial assertion references non-writable relation {relation_id}")
    # Instantiation catches missing relation args, bad field references, and duplicate entities.
    definition.instantiate()


def validate_rules(definition: GameDefinition) -> None:
    seen: set[str] = set()
    for rule in definition.rules:
        if rule.id in seen:
            raise SchemaError(f"duplicate rule {rule.id}")
        seen.add(rule.id)
        if rule.pattern.action not in definition.actions:
            raise SchemaError(f"rule {rule.id} references unknown action {rule.pattern.action}")
        action = definition.action(rule.pattern.action)
        action_args = {param.id for param in action.parameters}
        for arg_id in rule.pattern.args:
            if arg_id not in action_args:
                raise SchemaError(f"rule {rule.id} matches unknown action arg {arg_id}")
        validate_predicate_refs(rule.guard, definition, f"rule {rule.id}.when")
        validate_effect_refs(rule.effects, definition, f"rule {rule.id}.effects")


def validate_predicate_refs(predicate: Any, definition: GameDefinition, context: str) -> None:
    if predicate is None or isinstance(predicate, bool):
        return
    if isinstance(predicate, list):
        for index, item in enumerate(predicate):
            validate_predicate_refs(item, definition, f"{context}[{index}]")
        return
    if not isinstance(predicate, dict) or len(predicate) != 1:
        raise SchemaError(f"{context} must be a predicate")
    op, operand = next(iter(predicate.items()))
    if op == "not":
        validate_predicate_refs(operand, definition, f"{context}.not")
    elif op in {"all", "any"}:
        if not isinstance(operand, list):
            raise SchemaError(f"{context}.{op} must be a list")
        for index, item in enumerate(operand):
            validate_predicate_refs(item, definition, f"{context}.{op}[{index}]")
    elif op == "relation":
        relation_id = operand.get("id")
        if relation_id not in definition.relations:
            raise SchemaError(f"{context} references unknown relation {relation_id}")
    elif op == "fact":
        return
    elif op == "has_trait":
        trait_id = operand.get("trait")
        if trait_id not in definition.traits:
            raise SchemaError(f"{context} references unknown trait {trait_id}")
    elif op in {"eq", "compare"}:
        return
    else:
        raise SchemaError(f"{context} uses unknown predicate op {op}")


def validate_effect_refs(effects: tuple[dict[str, Any], ...] | list[dict[str, Any]], definition: GameDefinition, context: str) -> None:
    for index, effect in enumerate(effects):
        if not isinstance(effect, dict) or len(effect) != 1:
            raise SchemaError(f"{context}[{index}] must be an effect")
        op, operand = next(iter(effect.items()))
        if op == "assert":
            relation_id = operand.get("relation")
            if relation_id not in definition.relations:
                raise SchemaError(f"{context}[{index}] references unknown relation {relation_id}")
            if not definition.relation(relation_id).can_assert():
                raise SchemaError(f"{context}[{index}] references non-writable relation {relation_id}")
        elif op in {"set_fact", "clear_fact", "emit", "set_field", "destroy"}:
            continue
        elif op == "create":
            kind_id = operand.get("kind")
            if kind_id is not None and kind_id not in definition.kinds:
                raise SchemaError(f"{context}[{index}] references unknown kind {kind_id}")
        elif op == "grant_trait":
            trait = operand.get("trait")
            trait_id = trait.get("id") if isinstance(trait, dict) else trait
            if trait_id not in definition.traits:
                raise SchemaError(f"{context}[{index}] references unknown trait {trait_id}")
        elif op == "revoke_trait":
            if operand.get("trait") not in definition.traits:
                raise SchemaError(f"{context}[{index}] references unknown trait {operand.get('trait')}")
        else:
            raise SchemaError(f"{context}[{index}] uses unknown effect op {op}")


def validate_trait_fields(trait: TraitDefinition, fields: dict[str, Any], context: str) -> None:
    known = {field.id for field in trait.fields}
    for field_id in fields:
        if field_id not in known:
            raise SchemaError(f"{context} references unknown field {field_id}")


def validate_types(type_refs: list[str], traits: dict[str, TraitDefinition]) -> None:
    for type_ref in type_refs:
        for trait_id in re.findall(r"ref<([^>]+)>", type_ref):
            if trait_id not in traits and trait_id != "Entity":
                raise SchemaError(f"type references unknown trait {trait_id}")


def validate_unique(values: list[str], context: str) -> None:
    seen: set[str] = set()
    for value in values:
        if value in seen:
            raise SchemaError(f"{context} duplicates {value}")
        seen.add(value)


def assign_rule_orders(rules: list[Rule]) -> list[Rule]:
    assigned: list[Rule] = []
    for order, rule in enumerate(rules):
        assigned.append(
            Rule(
                id=rule.id,
                phase=rule.phase,
                pattern=rule.pattern,
                effects=rule.effects,
                guard=rule.guard,
                control=rule.control,
                priority=rule.priority,
                order=order,
            )
        )
    return assigned


def combine_guards(left: Any, right: Any) -> Any:
    if left is True:
        return copy.deepcopy(right)
    if right is True:
        return copy.deepcopy(left)
    return {"all": [copy.deepcopy(left), copy.deepcopy(right)]}


def rewrite_rule_this(rule: Rule, entity_id: str, order: int) -> Rule:
    return Rule(
        id=f"{entity_id}.{rule.id}",
        phase=rule.phase,
        pattern=ActionPattern(rule.pattern.action, rewrite_this(rule.pattern.args, entity_id)),
        effects=tuple(rewrite_this(effect, entity_id) for effect in rule.effects),
        guard=rewrite_this(rule.guard, entity_id),
        control=rule.control,
        priority=rule.priority,
        order=order,
    )


def rewrite_this(value: Any, entity_id: str) -> Any:
    if isinstance(value, list):
        return [rewrite_this(item, entity_id) for item in value]
    if isinstance(value, dict):
        if value == {"var": "this"}:
            return {"ref": entity_id}
        return {key: rewrite_this(item, entity_id) for key, item in value.items()}
    return value


def ensure_unique(mapping: dict[str, Any], key: str, label: str) -> None:
    if key in mapping:
        raise SchemaError(f"duplicate {label}")


def require_mapping(data: dict[str, Any], field: str, context: str, default: Any = None) -> dict[str, Any]:
    if field not in data:
        return copy.deepcopy(default)
    return require_mapping_value(data[field], f"{context}.{field}")


def require_mapping_value(value: Any, context: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SchemaError(f"{context} must be a mapping")
    return value


def require_list(data: dict[str, Any], field: str, context: str, default: Any = None) -> list[Any]:
    if field not in data:
        return copy.deepcopy(default)
    value = data[field]
    if not isinstance(value, list):
        raise SchemaError(f"{context}.{field} must be a list")
    return value


def require_id(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value.strip() or ID_RE.match(value) is None:
        raise SchemaError(f"{context} must be an id matching {ID_RE.pattern}")
    return value


def require_string(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SchemaError(f"{context} must be a non-empty string")
    return value


def default_value(mapping: dict[str, Any]) -> Any:
    if "default" not in mapping:
        return MISSING
    return copy.deepcopy(mapping["default"])

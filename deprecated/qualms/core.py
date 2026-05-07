from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any


MISSING = object()
PredicateSpec = Any
EffectSpec = dict[str, Any]
ExpressionSpec = Any
Bindings = dict[str, Any]


@dataclass(frozen=True)
class ParameterDefinition:
    id: str
    type: str = "value"
    default: Any = MISSING


@dataclass(frozen=True)
class FieldDefinition:
    id: str
    type: str = "value"
    default: Any = MISSING


@dataclass(frozen=True)
class TraitDefinition:
    id: str
    parameters: tuple[ParameterDefinition, ...] = ()
    fields: tuple[FieldDefinition, ...] = ()
    relations: tuple["RelationDefinition", ...] = ()
    actions: tuple["ActionDefinition", ...] = ()
    rules: tuple["Rule", ...] = ()
    constraints: tuple[PredicateSpec, ...] = ()

    def default_fields(self) -> dict[str, Any]:
        defaults: dict[str, Any] = {}
        for field_def in self.fields:
            if field_def.default is not MISSING:
                defaults[field_def.id] = copy.deepcopy(field_def.default)
        return defaults

    def field_definition(self, field_id: str) -> FieldDefinition:
        for field_def in self.fields:
            if field_def.id == field_id:
                return field_def
        raise KeyError(f"{self.id}.{field_id}")


@dataclass
class TraitInstance:
    definition_id: str
    parameters: dict[str, Any] = field(default_factory=dict)
    fields: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class TraitAttachment:
    id: str
    parameters: dict[str, Any] = field(default_factory=dict)
    fields: dict[str, Any] = field(default_factory=dict)


@dataclass
class Entity:
    id: str
    traits: dict[str, TraitInstance] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    def has_trait(self, trait_id: str) -> bool:
        return trait_id in self.traits

    def trait(self, trait_id: str) -> TraitInstance:
        try:
            return self.traits[trait_id]
        except KeyError as error:
            raise KeyError(f"{self.id} lacks trait {trait_id}") from error


@dataclass(frozen=True)
class RelationDefinition:
    id: str
    parameters: tuple[ParameterDefinition, ...]
    get: PredicateSpec | None = None
    set_effects: tuple[EffectSpec, ...] | None = None
    persistence: str | None = None

    def can_assert(self) -> bool:
        return self.set_effects is not None or self.persistence is not None


@dataclass(frozen=True)
class ActionDefinition:
    id: str
    parameters: tuple[ParameterDefinition, ...] = ()
    requires: PredicateSpec = True
    default_effects: tuple[EffectSpec, ...] = ()


@dataclass(frozen=True)
class ActionPattern:
    action: str
    args: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Rule:
    id: str
    phase: str
    pattern: ActionPattern
    effects: tuple[EffectSpec, ...] = ()
    guard: PredicateSpec = True
    control: str = "continue"
    priority: int = 0
    order: int = 0


@dataclass(frozen=True)
class KindDefinition:
    id: str
    traits: tuple[TraitAttachment, ...] = ()
    fields: dict[str, dict[str, Any]] = field(default_factory=dict)
    rules: tuple[Rule, ...] = ()


@dataclass(frozen=True)
class EntitySpec:
    id: str
    kind: str | None = None
    traits: tuple[TraitAttachment, ...] = ()
    fields: dict[str, dict[str, Any]] = field(default_factory=dict)
    rules: tuple[Rule, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class MemoryStore:
    facts: set[tuple[str, tuple[Any, ...]]] = field(default_factory=set)

    def has(self, fact_id: str, args: list[Any] | tuple[Any, ...] = ()) -> bool:
        return (fact_id, tuple(make_hashable(arg) for arg in args)) in self.facts

    def set(self, fact_id: str, args: list[Any] | tuple[Any, ...] = ()) -> None:
        self.facts.add((fact_id, tuple(make_hashable(arg) for arg in args)))

    def clear(self, fact_id: str, args: list[Any] | tuple[Any, ...] = ()) -> None:
        self.facts.discard((fact_id, tuple(make_hashable(arg) for arg in args)))


@dataclass
class WorldState:
    definition: "GameDefinition"
    entities: dict[str, Entity] = field(default_factory=dict)
    memory: MemoryStore = field(default_factory=MemoryStore)
    current_relations: set[tuple[str, tuple[Any, ...]]] = field(default_factory=set)
    remembered_relations: set[tuple[str, tuple[Any, ...]]] = field(default_factory=set)
    events: list[dict[str, Any]] = field(default_factory=list)
    allocators: dict[str, int] = field(default_factory=dict)

    def clone(self) -> "WorldState":
        return copy.deepcopy(self)

    def replace_from(self, other: "WorldState") -> None:
        self.entities = other.entities
        self.memory = other.memory
        self.current_relations = other.current_relations
        self.remembered_relations = other.remembered_relations
        self.events = other.events
        self.allocators = other.allocators

    def entity(self, entity_id: str) -> Entity:
        try:
            return self.entities[entity_id]
        except KeyError as error:
            raise KeyError(f"unknown entity {entity_id}") from error

    def has_trait(self, entity_id: str, trait_id: str) -> bool:
        return self.entity(entity_id).has_trait(trait_id)

    def get_field(self, entity_id: str, trait_id: str, field_id: str) -> Any:
        return self.entity(entity_id).trait(trait_id).fields.get(field_id)

    def set_field(self, entity_id: str, trait_id: str, field_id: str, value: Any) -> None:
        entity = self.entity(entity_id)
        trait = entity.trait(trait_id)
        self.definition.trait(trait_id).field_definition(field_id)
        trait.fields[field_id] = value

    def grant_trait(self, entity_id: str, attachment: TraitAttachment) -> None:
        entity = self.entity(entity_id)
        entity.traits[attachment.id] = self.definition.build_trait_instance(attachment)

    def revoke_trait(self, entity_id: str, trait_id: str) -> None:
        self.entity(entity_id).traits.pop(trait_id, None)

    def test(self, relation_id: str, args: list[Any] | tuple[Any, ...]) -> bool:
        relation = self.definition.relation(relation_id)
        if relation.persistence is not None:
            return self._stored_relation_key(relation_id, args) in self._relation_store_for_test(relation.persistence)
        if relation.get is None:
            raise ValueError(f"relation {relation_id} has no tester")
        bindings = relation_bindings(relation, args)
        return bool(evaluate_predicate(relation.get, self, bindings))

    def assert_relation(self, relation_id: str, args: list[Any] | tuple[Any, ...]) -> None:
        relation = self.definition.relation(relation_id)
        if relation.persistence is not None:
            key = self._stored_relation_key(relation_id, args)
            for store in self._relation_stores_for_write(relation.persistence):
                store.add(key)
            return
        if relation.set_effects is None:
            raise ValueError(f"relation {relation_id} is not writable")
        bindings = relation_bindings(relation, args)
        apply_effects(relation.set_effects, self, bindings)

    def retract_relation(self, relation_id: str, args: list[Any] | tuple[Any, ...]) -> None:
        relation = self.definition.relation(relation_id)
        if relation.persistence is None:
            raise ValueError(f"relation {relation_id} is not stored")
        key = self._stored_relation_key(relation_id, args)
        for store in self._relation_stores_for_write(relation.persistence):
            store.discard(key)

    def allocate(self, prefix: str) -> str:
        next_value = self.allocators.get(prefix, 1)
        self.allocators[prefix] = next_value + 1
        return f"{prefix}-{next_value}"

    def _stored_relation_key(self, relation_id: str, args: list[Any] | tuple[Any, ...]) -> tuple[str, tuple[Any, ...]]:
        relation = self.definition.relation(relation_id)
        relation_bindings(relation, args)
        return (relation_id, tuple(make_hashable(arg) for arg in args))

    def _relation_stores_for_write(self, persistence: str) -> tuple[set[tuple[str, tuple[Any, ...]]], ...]:
        if persistence == "current":
            return (self.current_relations,)
        if persistence == "remembered":
            return (self.remembered_relations,)
        if persistence == "both":
            return (self.current_relations, self.remembered_relations)
        raise ValueError(f"unknown relation persistence {persistence}")

    def _relation_store_for_test(self, persistence: str) -> set[tuple[str, tuple[Any, ...]]]:
        if persistence == "current":
            return self.current_relations
        if persistence == "remembered":
            return self.remembered_relations
        if persistence == "both":
            return self.current_relations | self.remembered_relations
        raise ValueError(f"unknown relation persistence {persistence}")


@dataclass(frozen=True)
class GameDefinition:
    traits: dict[str, TraitDefinition] = field(default_factory=dict)
    relations: dict[str, RelationDefinition] = field(default_factory=dict)
    actions: dict[str, ActionDefinition] = field(default_factory=dict)
    rules: tuple[Rule, ...] = ()
    kinds: dict[str, KindDefinition] = field(default_factory=dict)
    initial_entities: tuple[EntitySpec, ...] = ()
    initial_assertions: tuple[dict[str, Any], ...] = ()
    initial_facts: tuple[dict[str, Any], ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "traits", dict(self.traits))
        object.__setattr__(self, "relations", dict(self.relations))
        object.__setattr__(self, "actions", dict(self.actions))
        object.__setattr__(self, "kinds", dict(self.kinds))
        self._include_contributed_definitions()

    def _include_contributed_definitions(self) -> None:
        for trait_def in list(self.traits.values()):
            for relation in trait_def.relations:
                if relation.id in self.relations:
                    if self.relations[relation.id] != relation:
                        raise ValueError(f"duplicate relation {relation.id}")
                    continue
                self.relations[relation.id] = relation
            for action in trait_def.actions:
                if action.id in self.actions:
                    if self.actions[action.id] != action:
                        raise ValueError(f"duplicate action {action.id}")
                    continue
                self.actions[action.id] = action
        existing_rule_ids = {rule.id for rule in self.rules}
        contributed_rules = [
            rule
            for trait_def in self.traits.values()
            for rule in trait_def.rules
            if rule.id not in existing_rule_ids
        ]
        if contributed_rules:
            object.__setattr__(self, "rules", (*self.rules, *contributed_rules))

    def trait(self, trait_id: str) -> TraitDefinition:
        try:
            return self.traits[trait_id]
        except KeyError as error:
            raise KeyError(f"unknown trait {trait_id}") from error

    def relation(self, relation_id: str) -> RelationDefinition:
        try:
            return self.relations[relation_id]
        except KeyError as error:
            raise KeyError(f"unknown relation {relation_id}") from error

    def action(self, action_id: str) -> ActionDefinition:
        try:
            return self.actions[action_id]
        except KeyError as error:
            raise KeyError(f"unknown action {action_id}") from error

    def kind(self, kind_id: str) -> KindDefinition:
        try:
            return self.kinds[kind_id]
        except KeyError as error:
            raise KeyError(f"unknown kind {kind_id}") from error

    def build_trait_instance(self, attachment: TraitAttachment) -> TraitInstance:
        trait_def = self.trait(attachment.id)
        fields = trait_def.default_fields()
        fields.update(copy.deepcopy(attachment.fields))
        return TraitInstance(
            definition_id=attachment.id,
            parameters=copy.deepcopy(attachment.parameters),
            fields=fields,
        )

    def build_entity(self, spec: EntitySpec) -> Entity:
        trait_attachments: dict[str, TraitAttachment] = {}
        field_overrides: dict[str, dict[str, Any]] = {}
        rules: list[Rule] = []

        if spec.kind:
            kind = self.kind(spec.kind)
            for attachment in kind.traits:
                trait_attachments[attachment.id] = attachment
            field_overrides.update(copy.deepcopy(kind.fields))
            rules.extend(kind.rules)

        for attachment in spec.traits:
            if attachment.id in trait_attachments:
                previous = trait_attachments[attachment.id]
                merged_fields = {**previous.fields, **attachment.fields}
                merged_parameters = {**previous.parameters, **attachment.parameters}
                trait_attachments[attachment.id] = TraitAttachment(attachment.id, merged_parameters, merged_fields)
            else:
                trait_attachments[attachment.id] = attachment
        deep_spec_fields = copy.deepcopy(spec.fields)
        for trait_id, fields in deep_spec_fields.items():
            field_overrides.setdefault(trait_id, {}).update(fields)
        rules.extend(spec.rules)

        entity = Entity(id=spec.id, metadata=copy.deepcopy(spec.metadata))
        if spec.kind:
            entity.metadata.setdefault("kind", spec.kind)
        if rules:
            entity.metadata.setdefault("rules", []).extend(rule.id for rule in rules)
        for trait_id, attachment in trait_attachments.items():
            override = field_overrides.get(trait_id, {})
            merged = TraitAttachment(
                id=attachment.id,
                parameters=attachment.parameters,
                fields={**attachment.fields, **override},
            )
            entity.traits[trait_id] = self.build_trait_instance(merged)
        return entity

    def instantiate(self) -> WorldState:
        state = WorldState(definition=self)
        for spec in self.initial_entities:
            if spec.id in state.entities:
                raise ValueError(f"duplicate entity {spec.id}")
            state.entities[spec.id] = self.build_entity(spec)
        for fact in self.initial_facts:
            fact_id = fact["id"]
            args = [evaluate_expression(arg, state, {}) for arg in fact.get("args", [])]
            state.memory.set(fact_id, args)
        for assertion in self.initial_assertions:
            relation_id = assertion["relation"]
            args = [evaluate_expression(arg, state, {}) for arg in assertion.get("args", [])]
            state.assert_relation(relation_id, args)
        return state


@dataclass(frozen=True)
class ActionAttempt:
    action_id: str
    args: dict[str, Any] = field(default_factory=dict)
    source: dict[str, Any] | None = None


@dataclass(frozen=True)
class ActionResult:
    status: str
    events: tuple[dict[str, Any], ...] = ()
    error: str | None = None

    @property
    def succeeded(self) -> bool:
        return self.status == "succeeded"


class RulesEngine:
    def __init__(self, definition: GameDefinition):
        self.definition = definition

    def attempt(self, state: WorldState, action: ActionAttempt) -> ActionResult:
        start_event_count = len(state.events)
        try:
            action_def = self.definition.action(action.action_id)
            self._validate_action_args(action_def, action)
            working = state.clone()
            bindings = dict(action.args)
            if not evaluate_predicate(action_def.requires, working, bindings):
                return ActionResult("rejected")

            before_result = self._run_phase("before", working, action, bindings)
            if before_result == "stop":
                state.replace_from(working)
                return ActionResult("blocked", tuple(state.events[start_event_count:]))

            default_replaced = self._run_phase("instead", working, action, bindings) == "stop"
            if not default_replaced:
                apply_effects(action_def.default_effects, working, bindings)

            self._run_phase("after", working, action, bindings)
            state.replace_from(working)
            return ActionResult("succeeded", tuple(state.events[start_event_count:]))
        except Exception as error:
            return ActionResult("failed", error=str(error))

    def _validate_action_args(self, action_def: ActionDefinition, action: ActionAttempt) -> None:
        supplied = set(action.args)
        expected = {parameter.id for parameter in action_def.parameters}
        unknown = supplied - expected
        if unknown:
            raise ValueError(f"{action.action_id} got unknown args: {', '.join(sorted(unknown))}")
        missing = [parameter.id for parameter in action_def.parameters if parameter.default is MISSING and parameter.id not in supplied]
        if missing:
            raise ValueError(f"{action.action_id} missing args: {', '.join(missing)}")

    def _run_phase(self, phase: str, state: WorldState, action: ActionAttempt, action_bindings: Bindings) -> str:
        rules = sorted(
            (rule for rule in self.definition.rules if rule.phase == phase),
            key=lambda rule: (rule.priority, rule.order),
        )
        for rule in rules:
            bindings = match_rule(rule, action, action_bindings)
            if bindings is None:
                continue
            if not evaluate_predicate(rule.guard, state, bindings):
                continue
            apply_effects(rule.effects, state, bindings)
            if rule.control == "stop":
                return "stop"
        return "continue"


def relation_bindings(relation: RelationDefinition, args: list[Any] | tuple[Any, ...]) -> Bindings:
    if len(args) != len(relation.parameters):
        raise ValueError(f"{relation.id} expects {len(relation.parameters)} args, got {len(args)}")
    return {parameter.id: arg for parameter, arg in zip(relation.parameters, args)}


def match_rule(rule: Rule, action: ActionAttempt, action_bindings: Bindings) -> Bindings | None:
    if rule.pattern.action != action.action_id:
        return None
    bindings = dict(action_bindings)
    for arg_id, pattern in rule.pattern.args.items():
        if arg_id not in action.args:
            return None
        value = action.args[arg_id]
        if not match_pattern_value(pattern, value, bindings):
            return None
    return bindings


def match_pattern_value(pattern: Any, value: Any, bindings: Bindings) -> bool:
    if isinstance(pattern, dict) and len(pattern) == 1:
        op, operand = next(iter(pattern.items()))
        if op == "bind":
            if operand in bindings:
                return bindings[operand] == value
            bindings[operand] = value
            return True
        if op == "var":
            return bindings[operand] == value
        if op == "ref":
            return operand == value
        if op == "literal":
            return operand == value
    return pattern == value


def evaluate_predicate(spec: PredicateSpec, state: WorldState, bindings: Bindings) -> bool:
    if isinstance(spec, bool):
        return spec
    if spec is None:
        return True
    if not isinstance(spec, dict) or len(spec) != 1:
        raise ValueError(f"invalid predicate {spec!r}")

    op, operand = next(iter(spec.items()))
    if op == "not":
        return not evaluate_predicate(operand, state, bindings)
    if op == "all":
        return all(evaluate_predicate(item, state, bindings) for item in operand)
    if op == "any":
        return any(evaluate_predicate(item, state, bindings) for item in operand)
    if op == "relation":
        args = [evaluate_expression(arg, state, bindings) for arg in operand.get("args", [])]
        return state.test(operand["id"], args)
    if op == "fact":
        args = [evaluate_expression(arg, state, bindings) for arg in operand.get("args", [])]
        return state.memory.has(operand["id"], args)
    if op == "has_trait":
        entity_id = evaluate_expression(operand["entity"], state, bindings)
        return state.has_trait(entity_id, operand["trait"])
    if op == "eq":
        left, right = operand
        return evaluate_expression(left, state, bindings) == evaluate_expression(right, state, bindings)
    if op == "compare":
        left = evaluate_expression(operand["left"], state, bindings)
        right = evaluate_expression(operand["right"], state, bindings)
        compare_op = operand["op"]
        if compare_op == "==":
            return left == right
        if compare_op == "!=":
            return left != right
        if compare_op == "<":
            return left < right
        if compare_op == "<=":
            return left <= right
        if compare_op == ">":
            return left > right
        if compare_op == ">=":
            return left >= right
        raise ValueError(f"unknown comparison op {compare_op}")
    if op == "contains":
        collection = evaluate_expression(operand["collection"], state, bindings)
        item = evaluate_expression(operand["item"], state, bindings)
        return item in collection
    raise ValueError(f"unknown predicate op {op}")


def evaluate_expression(spec: ExpressionSpec, state: WorldState, bindings: Bindings) -> Any:
    if isinstance(spec, list):
        return [evaluate_expression(item, state, bindings) for item in spec]
    if not isinstance(spec, dict):
        return spec
    if len(spec) != 1:
        return {key: evaluate_expression(value, state, bindings) for key, value in spec.items()}

    op, operand = next(iter(spec.items()))
    if op == "literal":
        return operand
    if op == "ref":
        return operand
    if op == "var":
        try:
            return bindings[operand]
        except KeyError as error:
            raise KeyError(f"unknown variable {operand}") from error
    if op == "field":
        entity_id = evaluate_expression(operand["entity"], state, bindings)
        return state.get_field(entity_id, operand["trait"], operand["field"])
    if op == "add":
        if not isinstance(operand, list):
            raise ValueError("add expression expects a list")
        return sum(evaluate_expression(item, state, bindings) for item in operand)
    if op == "allocate":
        prefix = str(evaluate_expression(operand, state, bindings))
        return state.allocate(prefix)
    return {op: evaluate_expression(operand, state, bindings)}


def apply_effects(effects: tuple[EffectSpec, ...] | list[EffectSpec], state: WorldState, bindings: Bindings) -> None:
    for effect in effects:
        apply_effect(effect, state, bindings)


def apply_effect(effect: EffectSpec, state: WorldState, bindings: Bindings) -> None:
    if not isinstance(effect, dict) or len(effect) != 1:
        raise ValueError(f"invalid effect {effect!r}")
    op, operand = next(iter(effect.items()))
    if op == "assert":
        args = [evaluate_expression(arg, state, bindings) for arg in operand.get("args", [])]
        state.assert_relation(operand["relation"], args)
        return
    if op == "retract":
        args = [evaluate_expression(arg, state, bindings) for arg in operand.get("args", [])]
        state.retract_relation(operand["relation"], args)
        return
    if op == "set_fact":
        args = [evaluate_expression(arg, state, bindings) for arg in operand.get("args", [])]
        state.memory.set(operand["id"], args)
        return
    if op == "clear_fact":
        args = [evaluate_expression(arg, state, bindings) for arg in operand.get("args", [])]
        state.memory.clear(operand["id"], args)
        return
    if op == "emit":
        event = {key: evaluate_expression(value, state, bindings) for key, value in operand.items()}
        event.setdefault("type", "emit")
        state.events.append(event)
        return
    if op == "create":
        entity_id = evaluate_expression(operand["id"], state, bindings)
        traits = tuple(trait_attachment_from_raw(raw) for raw in operand.get("traits", []))
        spec = EntitySpec(
            id=entity_id,
            kind=operand.get("kind"),
            traits=traits,
            fields=evaluate_expression(operand.get("fields", {}), state, bindings),
        )
        if entity_id in state.entities:
            raise ValueError(f"entity {entity_id} already exists")
        state.entities[entity_id] = state.definition.build_entity(spec)
        bindings[operand["bind"]] = entity_id
        return
    if op == "destroy":
        entity_id = evaluate_expression(operand, state, bindings)
        if entity_id not in state.entities:
            raise KeyError(f"unknown entity {entity_id}")
        del state.entities[entity_id]
        return
    if op == "grant_trait":
        entity_id = evaluate_expression(operand["entity"], state, bindings)
        state.grant_trait(entity_id, trait_attachment_from_raw(operand["trait"]))
        return
    if op == "revoke_trait":
        entity_id = evaluate_expression(operand["entity"], state, bindings)
        state.revoke_trait(entity_id, operand["trait"])
        return
    if op == "set_field":
        entity_id = evaluate_expression(operand["entity"], state, bindings)
        value = evaluate_expression(operand["value"], state, bindings)
        state.set_field(entity_id, operand["trait"], operand["field"], value)
        return
    raise ValueError(f"unknown effect op {op}")


def trait_attachment_from_raw(raw: Any) -> TraitAttachment:
    if isinstance(raw, TraitAttachment):
        return raw
    if isinstance(raw, str):
        return TraitAttachment(id=raw)
    return TraitAttachment(
        id=raw["id"],
        parameters=dict(raw.get("params", raw.get("parameters", {}))),
        fields=dict(raw.get("fields", {})),
    )


def make_hashable(value: Any) -> Any:
    if isinstance(value, list):
        return tuple(make_hashable(item) for item in value)
    if isinstance(value, dict):
        return tuple(sorted((key, make_hashable(item)) for key, item in value.items()))
    return value

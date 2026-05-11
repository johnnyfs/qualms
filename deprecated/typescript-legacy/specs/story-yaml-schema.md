# Story YAML Schema Specification

This document defines the intended YAML authoring schema for Qualms rules and story data. YAML is the authoring syntax; the semantic target is the runtime model in `specs/rules-engine.md`.

Status: draft v0.1.

## Document Shape

Every document is a YAML mapping:

```yaml
qualms: "0.1"
id: "stellar"
imports: []
definitions:
  traits: []
  relations: []
  actions: []
  kinds: []
  rulebooks: []
story:
  entities: []
  assertions: []
  facts: []
  start: {}
```

Required root fields:

- `qualms`: schema version string. Current draft value is `"0.1"`.
- `id`: document id, unique within the loaded package.

Optional root fields:

- `imports`: ordered list of YAML document paths or package ids.
- `definitions`: reusable engine/prelude/story definitions.
- `story`: authored initial world state.

All lists that affect behavior are ordered. Implementations must preserve order after import expansion.

## Ids

```text
Id := non-empty string matching ^[A-Za-z][A-Za-z0-9_.:-]*$
```

Uniqueness requirements after imports and compilation:

- Trait ids unique.
- Relation ids unique.
- Action ids unique.
- Kind ids unique.
- Rule ids unique within the compiled game definition.
- Entity ids unique within the initial world.
- Field ids unique within a trait.
- Parameter ids unique within one definition.

## Type References

Types are strings:

```text
bool
int
float
str
id
value
entity
ref
ref<TraitId>
list<T>
map<T>
T?
T | U
```

Examples:

```yaml
type: str
type: ref<Location>
type: ref<Relocatable>?
type: list<ref<Entity>>
type: int | float
```

`ref<TraitId>` means an entity reference whose target has the named trait. `entity` means any entity value. `value` means any schema value.

## Definitions

```yaml
definitions:
  traits: [TraitDefinition...]
  relations: [RelationDefinition...]
  actions: [ActionDefinition...]
  kinds: [KindDefinition...]
  rulebooks: [RuleBookDefinition...]
```

Definitions may appear in a shared prelude or in a story document. Imported definitions compile before local definitions.

## TraitDefinition

```yaml
id: Relocatable
params: []
fields:
  - id: location
    type: ref<Location>?
    default: null
relations: []
actions: []
rules: []
constraints: []
```

Fields:

- `id`: required trait id.
- `params`: ordered `ParameterDef` list, default `[]`.
- `fields`: ordered `FieldDef` list, default `[]`.
- `relations`: ordered `RelationDefinition` list contributed by the trait, default `[]`.
- `actions`: ordered `ActionDefinition` list contributed by the trait, default `[]`.
- `rules`: ordered `RuleDefinition` list contributed by the trait, default `[]`.
- `constraints`: ordered `Predicate` list, default `[]`.

Trait fields are private implementation state for that trait. Story-level rules should prefer relations.

## ParameterDef

```yaml
id: destination
type: ref<Location>
default: null
```

Fields:

- `id`: required parameter id.
- `type`: required type reference.
- `default`: optional value. If omitted, the parameter is required.

## FieldDef

```yaml
id: name
type: str
default: ""
```

Fields:

- `id`: required field id.
- `type`: required type reference.
- `default`: optional value. If omitted, the field must be supplied by a kind, trait attachment, or entity.

## RelationDefinition

Relations can be top-level or contributed by a trait.

```yaml
id: At
params:
  - id: subject
    type: ref<Relocatable>
  - id: location
    type: ref<Location>
get:
  eq:
    - field:
        entity: { var: subject }
        trait: Relocatable
        field: location
    - { var: location }
set:
  - set_field:
      entity: { var: subject }
      trait: Relocatable
      field: location
      value: { var: location }
```

Stored relation example:

```yaml
id: Visited
persistence: remembered
params:
  - id: actor
    type: ref<Actor>
  - id: location
    type: ref<Location>
```

Fields:

- `id`: required relation id.
- `params`: required ordered `ParameterDef` list.
- `get`: `Predicate`, required unless `persistence` is set.
- `set`: optional ordered `Effect` list.
- `persistence`: optional, one of `current`, `remembered`, or `both`.

Validation:

- Every parameter referenced by `get` or `set` must exist.
- `get` must be pure.
- `set` must not contain action attempts.
- `assert Relation(...)` is valid only when `set` or `persistence` is present.
- `retract Relation(...)` is valid only when `persistence` is present.

## ActionDefinition

```yaml
id: Move
params:
  - id: actor
    type: ref<Actor>?
  - id: subject
    type: ref<Relocatable>
  - id: destination
    type: ref<Location>
requires: true
default:
  - assert:
      relation: At
      args:
        - { var: subject }
        - { var: destination }
```

Fields:

- `id`: required action id.
- `params`: ordered `ParameterDef` list, default `[]`.
- `requires`: `Predicate`, default `true`.
- `default`: ordered `Effect` list, default `[]`.

Validation:

- All parameters must have unique ids.
- All variables used by `requires` and `default` must be parameters or effect-local bindings.
- Default effects must be declarative effects.

## RuleDefinition

```yaml
id: block_unprotected_entry
phase: before
priority: 0
match:
  action: Enter
  args:
    actor: { bind: actor }
    destination: { ref: lunar-surface }
when:
  not:
    relation:
      id: Equipped
      args:
        - { var: actor }
        - { ref: spare-expedition-suit }
effects:
  - emit:
      text: "As unbearable as life is here, you still prefer it to vacuum."
control: stop
```

Fields:

- `id`: required rule id before compilation within its scope. Compilers may prefix scope ids to make it globally unique.
- `phase`: required, one of `before`, `instead`, `after`.
- `priority`: integer, default `0`.
- `match`: required `ActionPattern`.
- `when`: `Predicate`, default `true`.
- `unless`: optional `Predicate` or list of predicates. Sugar for `not`.
- `effects`: ordered `Effect` list, default `[]`.
- `control`: one of `continue`, `stop`; default `continue`.

Validation:

- `match.action` must refer to a defined action.
- Pattern argument names must exist on that action.
- Variables introduced with `bind` are available to `when`, `unless`, and `effects`.
- Rules are compiled in document order after import expansion and kind/rulebook expansion.

## ActionPattern

```yaml
action: Use
args:
  actor: { bind: actor }
  source: { ref: portrait-of-enrick }
  target: { ref: control-console }
```

Pattern values:

- `{ ref: entity-id }`: requires exact entity.
- `{ literal: value }`: requires exact scalar/list/map value.
- `{ bind: name }`: binds the attempted argument to a variable.
- `{ var: name }`: requires equality with an existing variable.
- Omitted arguments are wildcards.

## Effect

Exactly one effect operation key must be present.

### assert

```yaml
- assert:
    relation: At
    args:
      - { ref: canary }
      - { ref: impact-crater }
```

Asserts a writable or stored relation. A relation with `set` applies those effects directly; a relation with `persistence` stores the tuple.

### retract

```yaml
- retract:
    relation: Aboard
    args:
      - { ref: player }
      - { ref: canary }
```

Retracts a stored relation tuple. This is valid only for relations with `persistence`.

### set_fact

```yaml
- set_fact:
    id: SequenceComplete
    args: [{ literal: blemish-crash }]
```

### clear_fact

```yaml
- clear_fact:
    id: SequenceComplete
    args: [{ literal: blemish-crash }]
```

### emit

```yaml
- emit:
    text: "The iris whirs with approval."
    channel: narrative
```

`channel` is optional. Interfaces may ignore channels they do not support.

### create

```yaml
- create:
    bind: enemy
    id:
      allocate: enemy
    kind: Enemy
    traits: []
    fields: {}
```

Fields:

- `bind`: required variable id for the created entity.
- `id`: required expression. `{ allocate: prefix }` uses the deterministic allocator in `WorldState`.
- `kind`: optional kind id.
- `traits`: additional `TraitAttachment` list, default `[]`.
- `fields`: optional shorthand map from trait id to field values.

`allocate` semantics:

- The allocator key is the evaluated prefix string.
- `WorldState` stores the next integer per prefix.
- The first allocation for `enemy` produces `enemy-1`, then `enemy-2`, and so on.
- Allocation is part of the action transaction.

### destroy

```yaml
- destroy: { var: enemy }
```

### grant_trait

```yaml
- grant_trait:
    entity: { ref: canary }
    trait:
      id: Controlled
      fields:
        by: { ref: player }
```

### revoke_trait

```yaml
- revoke_trait:
    entity: { ref: canary }
    trait: Controlled
```

### set_field

```yaml
- set_field:
    entity: { var: subject }
    trait: Relocatable
    field: location
    value: { var: destination }
```

`set_field` is intended for definitions and low-level preludes. Story content should use relation assertions where possible.

## Predicate

A predicate is either a boolean scalar or a mapping with exactly one operation key.

```yaml
true
```

```yaml
all:
  - relation: { id: At, args: [{ var: actor }, { var: location }] }
  - fact: { id: Knows, args: [{ var: actor }, { ref: canary }] }
```

Operations:

```yaml
not: Predicate
all: [Predicate...]
any: [Predicate...]
relation:
  id: RelationId
  args: [Expression...]
fact:
  id: FactId
  args: [Expression...]
has_trait:
  entity: Expression
  trait: TraitId
eq: [Expression, Expression]
compare:
  left: Expression
  op: "==" | "!=" | "<" | "<=" | ">" | ">="
  right: Expression
contains:
  collection: Expression
  item: Expression
```

Validation:

- Predicate operations are pure.
- Relation predicates must refer to defined relations.
- Relation argument count and types must match the relation definition.
- Fact ids do not require prior declaration in v0.1, but a prelude may choose to declare known fact shapes later.

## Expression

An expression is a scalar/list/map literal or a mapping with exactly one expression operation key.

Operations:

```yaml
literal: value
ref: EntityId
var: VariableId
field:
  entity: Expression
  trait: TraitId
  field: FieldId
allocate: PrefixExpression
```

Rules:

- Bare scalars are literals.
- `{ ref: id }` resolves an entity reference.
- `{ var: name }` resolves an action parameter, pattern binding, rulebook parameter, trait parameter, or effect-local binding.
- `{ field: ... }` is valid only in definitions that are allowed to access the referenced trait field.
- `{ allocate: prefix }` is valid only as `create.id`.

## Scoped Entity Id Authoring

Entity ids compile to stable full ids. YAML may use nesting or an explicit parent/origin to avoid repeating long prefixes:

```yaml
story:
  entities:
    - id: mining-colony-5
      kind: Destination
      children:
        - id: pointless-bar
          kind: Destination
        - id: object:portrait-of-enrick
          kind: StoryObject
    - id: control-console
      parent: canary:bridge
      kind: StoryObject
```

Compilation:

- A nested child id is appended to its parent with `:`.
- `parent: full:id` and `origin: full:id` are equivalent top-level shorthand for appending `id` to a full prefix.
- `children`, `parent`, and `origin` are authoring syntax only; runtime entity ids are ordinary full ids.
- Nesting or parent/origin does not assert containment, location, ownership, or any other relation.

Scoped local references use a leading colon:

```yaml
rules:
  - id: block-key
    phase: before
    match:
      action: Examine
      args:
        target: { ref: ":object:key" }
```

Resolution rules:

- `:local-id` resolves in the nearest entity scope, then outer scopes.
- Top-level `story.assertions`, `story.facts`, and `story.start` may use `:local-id` only when the local id is unique in the document.
- Full ids remain legal everywhere and are not rewritten.

## KindDefinition

Kinds are authoring templates. They compile into trait attachments, default field values, and contributed rules.

```yaml
id: Ship
traits:
  - id: Presentable
  - id: Location
  - id: Container
  - id: Relocatable
  - id: Boardable
  - id: Vehicle
fields:
  Presentable:
    name: "Unnamed ship"
rules: []
```

Fields:

- `id`: required kind id.
- `traits`: ordered `TraitAttachment` list, default `[]`.
- `fields`: optional shorthand map from trait id to field values.
- `rules`: ordered `RuleDefinition` list, default `[]`.

Validation:

- Trait ids must exist.
- Field overrides must target traits included by the kind.
- Kind expansion must be acyclic if kinds later gain inheritance/composition.

## RuleBookDefinition

Rulebooks are authoring/scoping constructs. They compile by conjoining their guard into each contained rule.

```yaml
id: local_system_rules
params:
  - id: this
    type: ref<System>
when:
  relation:
    id: At
    args:
      - { ref: player }
      - { var: this }
rules: []
```

Fields:

- `id`: required rulebook id.
- `params`: ordered `ParameterDef` list, default `[]`.
- `when`: `Predicate`, default `true`.
- `rules`: ordered `RuleDefinition` list, default `[]`.

Compilation:

```text
compiled_rule.when = all [rulebook.when, rule.when, not(rule.unless)]
```

Runtime implementations may optimize rulebook guards, but behavior must be equivalent to denormalization.

## TraitAttachment

```yaml
id: Presentable
params: {}
fields:
  name: "Mining Colony 5"
  description: "Home sweet home."
```

Fields:

- `id`: required trait id.
- `params`: optional parameter map.
- `fields`: optional field map.

Validation:

- The trait id must exist.
- Parameter and field names must exist.
- Values must match declared types.

## Story Section

```yaml
story:
  entities: [EntitySpec...]
  assertions: [Assertion...]
  facts: [FactSpec...]
  start:
    actor: player
    location: mining-colony-5
```

`story` may be omitted in pure prelude documents.

## EntitySpec

```yaml
id: mining-colony-5
kind: Destination
traits:
  - id: Presentable
    fields:
      name: "Mining Colony 5"
      description: "Home sweet home."
rules: []
```

Fields:

- `id`: required entity id.
- `kind`: optional kind id.
- `traits`: ordered `TraitAttachment` list, default `[]`.
- `fields`: optional shorthand map from trait id to field values.
- `rules`: ordered `RuleDefinition` list, default `[]`.
- `children`: ordered nested `EntitySpec` list, default `[]`.
- `parent` / `origin`: optional full id prefix for a top-level entity. At most one may be present.
- `metadata`: optional mapping ignored by the core runtime.

Compilation:

1. Expand `kind` traits, fields, and rules.
2. Merge entity `traits` and `fields`.
3. Entity-local trait fields override kind defaults.
4. Entity-local rules compile into normal runtime rules.

Validation:

- Final entity must not contain duplicate trait ids.
- Final trait fields must satisfy all required field definitions.
- Entity-local rules may bind `this` to the entity id.

## Initial Assertions

```yaml
story:
  assertions:
    - relation: At
      args:
        - { ref: player }
        - { ref: mining-colony-5 }
    - relation: Contains
      args:
        - { ref: mining-colony-5 }
        - { ref: portrait-of-enrick }
```

Fields:

- `relation`: required relation id.
- `args`: required expression list.

Validation:

- The relation must be writable.
- Initial assertions apply in listed order after entity creation.

## Initial Facts

```yaml
story:
  facts:
    - id: SequenceComplete
      args: [{ literal: tutorial }]
```

Facts are untyped legacy memory state. New authored memory should generally be a stored relation such as `Visited(actor, location)` or `SequenceComplete(sequence)`.

## Start

The start object is interface-facing metadata. The core runtime only requires initial state; a UI may use `start` to choose an actor, camera, or first prompt.

```yaml
start:
  actor: player
  location: mining-colony-5
```

Recommended fields:

- `actor`: entity id for the default player/agent actor.
- `location`: entity id for the initial focus location.

## Minimal Prelude Example

```yaml
qualms: "0.1"
id: core-prelude
definitions:
  traits:
    - id: Actor

    - id: Location

    - id: Relocatable
      fields:
        - id: location
          type: ref<Location>?
          default: null
      relations:
        - id: At
          params:
            - { id: subject, type: ref<Relocatable> }
            - { id: location, type: ref<Location> }
          get:
            eq:
              - field: { entity: { var: subject }, trait: Relocatable, field: location }
              - { var: location }
          set:
            - set_field:
                entity: { var: subject }
                trait: Relocatable
                field: location
                value: { var: location }
      actions:
        - id: Move
          params:
            - { id: actor, type: ref<Actor>? }
            - { id: subject, type: ref<Relocatable> }
            - { id: destination, type: ref<Location> }
          requires: true
          default:
            - assert:
                relation: At
                args: [{ var: subject }, { var: destination }]
```

## Validation Phases

An implementation should validate in this order:

1. Parse YAML into plain data.
2. Validate root shape and schema version.
3. Resolve imports and detect import cycles.
4. Validate ids and duplicate definitions.
5. Validate type references.
6. Validate trait fields and parameter defaults.
7. Validate relation predicates and setters.
8. Validate action predicates and default effects.
9. Expand scoped entity ids and local refs.
10. Expand kinds and rulebooks.
11. Validate entity specs and initial assertions.
12. Validate rule patterns, variables, guards, and effects.
13. Instantiate initial `WorldState`.
14. Run prelude/story invariants, such as reciprocal hops for a nova-like prelude.

## Current Nova-Like Qualms Projection

The current game should become a prelude plus story:

- `System`, `Orbital`, `Destination`, `Ship`, `Person`, `NPC`, and `Thing` become kinds.
- `Presentable`, `Location`, `Relocatable`, `Container`, `Portable`, `Equipment`, `Actor`, `Vehicle`, `Boardable`, and `Jumpable` become traits.
- Current `before` entries become `before` rules.
- Current `use_rules` become `after` or `instead` rules matching `Use(source, target)`.
- Remaining string facts become stored relations where the shape is stable.
- Current nested destinations become entities plus initial `Contains`/`At`/`Orbits` assertions.

# Portable IR And World Contract

This document defines the language-neutral contract that a compliant Qualms
interpreter should expose. The TypeScript classes in `qualms/src/language/`
are one implementation of this contract, not the contract itself.

## Canonical Program Shape

A program is an ordered list of declarations:

```ts
type Program = { statements: Statement[] };

type Statement =
  | { kind: "trait"; id: string }
  | { kind: "relation"; id: string; parameters: RelationParameter[]; unique?: string[] }
  | { kind: "externPredicate"; id: string; parameters: Parameter[] }
  | { kind: "action" | "predicate"; id: string; parameters: Parameter[]; body: Block; replace?: boolean }
  | { kind: "rule"; phase: "before" | "after"; target: string; parameters: Parameter[]; body: Block }
  | { kind: "entity"; id: string; traits: string[] }
  | { kind: "extend"; id: string; traits: string[] }
  | { kind: "set"; effects: Effect[] }
  | { kind: "validation"; id: string; assertions: ValidationAssertion[] };
```

Implementations may store this in native classes, structs, records, tables, or
serialized JSON, but they must preserve declaration order where the language
semantics depend on it: program application, rule evaluation, and emitted
canonical output.

## Terms, Facts, And Effects

Ground world state is a set of facts:

```ts
type GroundTerm =
  | { kind: "id"; id: string }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "relation"; relation: string; args: GroundTerm[] };

type Fact = { relation: string; args: GroundTerm[] };
type Effect = { polarity: "assert" | "retract"; fact: Fact };
type Event = { event: string; args: GroundTerm[] };
```

Fact identity is structural: relation id plus structurally equal argument list.
Implementations must not depend on host-object identity, pointer identity, or
language-specific map iteration behavior except where the spec explicitly says
authoring order is significant.

## World Model

A loaded world model contains:

- `traits`: declared trait ids.
- `relations`: declared relation signatures and uniqueness/cardinality constraints.
- `externalPredicates`: pure host-adapter predicate signatures.
- `predicates`: pure callable definitions.
- `actions`: mutating callable definitions.
- `rules`: ordered rule declarations.
- `entities`: entity id to trait-id set.
- `facts`: structural fact set.
- `validations`: validation declarations.

All model mutations must pass semantic validation: known declarations, valid
arity, valid type references, valid relation-valued terms, and valid rule
targets.

## Runtime Operations

A compliant interpreter must provide these operations:

- `load(programs) -> World | Error`: apply programs in order.
- `query(world, expression, host?) -> QueryResult`: pure expression evaluation.
- `play(world, actionCall, host?) -> ActionResult`: atomic action execution.
- `mutate(world, programFragment) -> World | Error`: apply top-level
  declarations/effects to a candidate world.
- `validate(world) -> ValidationResult`: run all validation declarations.
- `emit(world) -> Program | Source`: produce canonical semantically equivalent
  output.

`query` and validation evaluation must not mutate `world`. `play` stages effects
and events against a candidate world and commits/returns them only when the
action body and all applicable `after` rules pass.

Action results must expose both human-readable and structured data:

```ts
type ActionResult = {
  status: "passed" | "failed";
  feedback: string;
  reasons: string[];
  effects: Effect[];
  events: Event[];
  failures: Failure[];
};

type Failure = {
  kind: "unknown_action" | "action_failed" | "condition" | "terminal";
  message: string;
  callable?: string;
};
```

## Host Simulation Boundary

The portable story contract does not call arbitrary host methods. Host
simulation state is exposed through declared `extern predicate` signatures and
an adapter object supplied to `query`, `play`, and validation calls.

Adapter requirements:

- Inputs are the predicate id and a fully grounded argument list.
- Results are deterministic booleans for the current host tick/frame.
- Adapter calls must be pure: no story-model mutation and no simulation
  mutation.
- Missing adapters or unresolved arguments evaluate as no match.
- Conformance tests that depend on adapters must provide replay fixtures that
  map `(predicate, args)` to booleans.

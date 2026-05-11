# Portable Story Contract Plan

This branch moves Qualms from "implemented tutorial DSL" toward a portable
story-engine contract that can be reimplemented in another language without
reverse-engineering the TypeScript runtime.

## Goals

- Define deterministic language semantics for loading, querying, action
  execution, mutation, validation, and world-state representation.
- Keep host simulation concerns outside the core story engine except through a
  narrow, typed, pure adapter boundary.
- Make model-authored changes safe to commit by adding first-class validations.
- Preserve the current tutorial behavior where compatible, but prefer precise
  semantics over accidental implementation behavior.

## Milestone 1: Pure Query And Predicate Semantics

- Queries must never mutate the story model.
- Predicate evaluation must be pure. A predicate body may not commit `set`
  effects when evaluated from `when`, `query`, or another predicate.
- Decide whether mutating predicates are rejected statically or evaluated in a
  read-only sandbox. The preferred contract is static rejection because it is
  easier to reimplement and reason about.
- Add tests proving that query and predicate calls cannot change facts.

## Milestone 2: Atomic Action Execution

- Stage all action effects against a candidate model.
- Commit staged effects only if the action body and all applicable `after`
  rules finish as passed.
- If an `after` rule fails, roll back the core action body and any earlier
  `after` effects from that call.
- Return structured effects for passed actions. Failed actions should return no
  committed effects; diagnostics may include staged/rolled-back effects later,
  but they are not part of the initial contract.
- Add tests for failure-after-set rollback, after-rule failure rollback, and
  unchanged existing tutorial flows.

## Milestone 3: Semantic Model Validation

- Validate relation arity on every asserted/retracted fact.
- Validate relation argument types, including relation-instance arguments.
- Validate entity references for trait-typed parameters and facts.
- Validate callable and rule arity at load/mutation time.
- Validate unknown type names, unknown callable targets, and invalid rule
  phases where applicable.
- Add negative tests for malformed worlds and positive tests for the tutorial.

## Milestone 4: First-Class Validations

- Add a top-level `validation Name { ... }` declaration.
- Support validation assertions for facts, queries, action outcomes, and
  absence of facts/query matches.
- Expose validation execution from the language package.
- Run validations before MCP `commit`; failed validations block commit and keep
  the transaction open for rollback or further mutation.
- Add tests for successful validation-gated commit and blocked commit.

## Milestone 5: Portable IR, Spec, UML, And Tutorial Updates

- Document canonical AST/IR and world-model JSON shapes independent of
  TypeScript classes.
- Update language semantics for pure predicates, atomic actions, validations,
  and semantic validation.
- Update UML to show validation declarations, validation results, staged action
  execution, and host adapter boundary.
- Update the tutorial comments where behavior changed or became more precise.
- Add a conformance-suite section mapping tutorial sections and validations to
  spec requirements.

## Milestone 6: Full Validation And Commits

- Run `pnpm -r test` and `pnpm -r typecheck`.
- Commit after each milestone with focused messages.
- Keep the branch history reviewable and avoid touching unrelated user work.

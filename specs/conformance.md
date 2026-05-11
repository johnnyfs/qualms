# Conformance Contracts

This document collects the portability rules that are not tied to one
TypeScript API. A compliant implementation should be able to use these rules
as fixture expectations.

## Query Dialect

Queries parse as `Expr` from `language.md`. Bare identifiers are ground ids
unless they already exist in the current environment. Free query bindings must
use explicit variables:

```qualms
At(Player, ?where)
```

The result row for a query contains every explicit variable bound by the
query. Ground identifiers such as `Player` are not echoed into the row.
Wildcards match without binding and therefore never appear in the row.

External predicates may appear in queries only when every argument is ground
after environment resolution. Unresolved external-predicate arguments evaluate
as no match.

## Round Trip

The canonical round trip is:

1. Parse one or more source files into ordered programs.
2. Apply the programs to a fresh model in load order.
3. Emit the model as canonical source or canonical IR.
4. Reparse and reload the emitted representation.

The two loaded worlds must have identical declarations, entity trait sets,
validation declarations, and structural fact sets. Byte-for-byte source
identity is not required. `extend` declarations may be folded into emitted
`entity` declarations, and fact emission may be normalized into a single
positive `set` block.

## Multi-File Persistence

A multi-file story is one logical program formed by applying files in an
explicit order. Load order is semantic because declarations, rules, and
replacement callables are order-sensitive.

A compliant persistence layer must track:

- the ordered file list used to build the model;
- the canonical model after applying all files;
- the target file or synthetic output chosen for commits;
- whether a mutation affects only declarations/facts that can be persisted to
  the selected target.

If a session was loaded from multiple files and no target path is supplied,
commit must fail rather than guessing where to write. Implementations may offer
structured diffs per file, but the language contract only requires that the
logical model be validated before any file is written.

## Adapter Replay Fixtures

Fixtures for external predicates are maps from grounded calls to booleans:

```json
{
  "CanSee(Player, Guard)": true,
  "CanSee(Player, Mop)": false
}
```

The call key is the canonical emitted predicate atom. During conformance
testing, missing keys evaluate as `false` unless the fixture explicitly asks
the runner to treat missing keys as errors.

## Minimal Fixture Set

The conformance suite should include dedicated fixtures for:

- explicit variable query binding;
- atomic rollback after body failure;
- atomic rollback after failing `after` rule;
- validation-gated commit behavior;
- entity-literal slot sugar;
- relation-valued argument validation;
- pure predicate and external-predicate enforcement;
- emitted event rollback on failed actions;
- explicit `unique(...)` replacement of legacy `one`.

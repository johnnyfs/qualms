# Remaining Recommendations

This branch moved Qualms substantially closer to a portable story-engine
contract, but it did not complete every recommendation from the original
evaluation. The items below remain intentionally open.

## Highest Priority

### 1. Explicit variable syntax

The language still uses bare identifiers for both entity references and
unbound variables. Reimplementation is possible, but the distinction remains
implicit and context-sensitive. Introduce explicit variable syntax such as
`?actor` or `$actor`, and reserve bare identifiers for entity literals and
declared symbols.

### 2. Cardinality redesign

`one` still works, but it encodes functional dependency indirectly. A more
portable and less surprising contract would make uniqueness explicit, for
example:

```qualms
relation At(subject: Locatable, location: Location) unique(subject)
```

That would also make multi-column uniqueness and future indexing rules easier
to specify.

### 3. Structured failure and event schema

`feedback` and `reasons` are still mostly text-oriented. They are useful for
human-facing tooling, but a portable engine should also expose a structured
result schema:

- machine-readable failure kinds
- failing rule/callable ids
- structured effect lists
- optional host-facing emitted events

The textual DSL fragments can remain as a rendering layer on top.

### 4. Host adapter contract

`portable-ir.md` establishes the boundary, but Qualms still lacks a concrete
adapter protocol for pure host-supplied predicates/relations. A next step is a
normative adapter contract covering:

- typed adapter signature registration
- purity and determinism requirements
- tick/frame consistency guarantees
- timeout/error handling
- replay fixture format for conformance tests

## Medium Priority

### 5. Validation language expansion

Validations currently cover fact presence/absence, query match/no-match, and
action passed/failed expectations. Useful additions would be:

- exact expected query bindings
- exact expected effects
- expected failure reason subsets
- named setup/teardown fixtures for validation suites

### 6. Multi-file persistence contract

`commit` still writes a single canonical `.qualms` output when a single target
path is available. The language/runtime contract should define what it means to
load, diff, validate, and persist a logically single story split across
multiple files.

### 7. Round-trip conformance spec

The branch tightened round-tripping behavior, but the conformance contract is
still not fully enumerated. Add a dedicated spec describing what must remain
stable across parse/load/emit/reparse cycles.

### 8. Query dialect spec

`query` behavior is documented, but the accepted surface and result-shaping
rules should be specified more concretely, especially around entity prebinding,
free variables, and relation-instance terms.

## Lower Priority

### 9. Numeric and comparison extensions

Numbers exist but the language still lacks arithmetic and ordered comparisons.
If those are added, they should come with a clear portability story and a
minimal deterministic operator set.

### 10. Additional conformance fixtures

The tutorial now covers more behavior, but the conformance suite would be
stronger with smaller dedicated fixtures for:

- atomic rollback behavior
- validation-gated commit behavior
- entity-literal slot sugar
- relation-valued argument validation
- pure predicate enforcement

## Recommendation

The next branch should prioritize explicit variable syntax and a structured
result schema before growing the language further. Those two changes would
reduce ambiguity for both engine implementers and model-authored tooling.

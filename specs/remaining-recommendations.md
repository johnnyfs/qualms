# Remaining Recommendations

The earlier high-priority portability gaps have been addressed:

- explicit variables use `?name`;
- relation uniqueness can be declared with `unique(...)`;
- play results expose structured failures, effects, and events;
- host simulation checks use declared `extern predicate` signatures and a pure
  runtime adapter;
- validations can assert exact single-row query bindings, exact play effects,
  and required failure reasons;
- query, round-trip, multi-file persistence, adapter replay, and conformance
  contracts are documented in `conformance.md`.

The remaining work is lower-risk polish and broader coverage.

## Open Items

### 1. External relation enumeration

`extern predicate` covers grounded host checks. It does not yet cover host
relations that enumerate rows for queries with unbound variables, such as
`Nearby(Player, ?object)`. Add this only if a host engine needs enumeration;
otherwise grounded predicates are easier to replay and keep deterministic.

### 2. Numeric and comparison extensions

Numbers exist as terms, but the language still lacks arithmetic and ordered
comparisons. If added, keep the operator set small and deterministic across
host languages.

### 3. Validation fixtures

The validation language now covers the main regression needs, but fixtures are
still inline unit tests. A future branch should add standalone `.qualms`
fixtures plus expected JSON results so non-TypeScript implementations can run
the same suite.

### 4. Structured rule identifiers

Structured failures include failure kind, message, and callable id. They do not
yet include stable rule ids because rules are currently anonymous and ordered.
If toolchains need exact rule blame, add optional rule labels to the DSL before
putting rule indexes into a public contract.

### 5. Multi-file diff persistence

The conformance contract says when a multi-file commit is valid, but the MCP
implementation still writes canonical output to a selected target. A richer
authoring workflow could preserve per-file ownership and generate structured
file-level diffs.

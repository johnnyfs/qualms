# MCP server smoke log — step 6

Step-6 deliverable: hand-run the server against the migrated prelude with no
story files; document outcomes and rough edges.

Driver: `mcp/scripts/smoke.ts`. Re-run with:

```bash
cd mcp && pnpm exec tsx scripts/smoke.ts
```

## Outcomes (all expected)

### Discovery

`tools/list` returned three tools — `__start`, `__quit`, `__query` — with
their descriptions intact.

### __start

- Returned a UUID-shaped `sessionId`.
- `loaded.counts`: **traits=10, relations=13, actions=9, kinds=4, rules=1**.
  Matches the migrated prelude exactly:
  - 10 traits: Presentable, Actor, Location, Relocatable, Scope, Container,
    Portable, Usable, Equipment, Ownable.
  - 13 relations: Path, At, Aboard, CanTouch, CanSee, Contains, Equipped,
    OwnedBy, CarriedBy, Named, Visible, Visited, IsPlayer.
  - 9 actions: Move, Take, Drop, Use, Equip, Unequip, Name, Examine, Enter.
  - 4 kinds: Thing, Place, Person, Item.
  - 1 rule: remember-visited-location.

### __query (positive cases)

| Label | Expression | Result |
|---|---|---|
| kinds with Presentable | `{ k : Kind | uses(k, "Presentable") }` | Thing, Place, Person, Item |
| Item kind contents | `{ t | uses("Item", t) }` | Presentable, Relocatable |
| IsPlayer relation exists | `?- exists r : Relation. r.id = "IsPlayer"` | count=1 |
| SequenceComplete absent | `?- exists r : Relation. r.id = "SequenceComplete"` | count=0 |
| /^Can/ prelude relations | `{ r : Relation@prelude | r.id =~ /^Can/ }` | CanTouch, CanSee |
| @game traits empty | `{ t : Trait@game | true }` | count=0 |
| all prelude traits | `{ t : Trait@prelude | true }` | all 10 |
| rules count via meta | `{ r : Rule | true }` | remember-visited-location |
| actions in prelude | `{ a : Action@prelude | true }` | all 9 |

### __query (negative cases)

- Bad `sessionId`: returns `isError=true` with text `session 'nope' not found`.
- Parse error (`?- @bad`): `isError=true`, category=`parse`, span at offset 3.
  (Verbose error message — see "rough edges" below.)

### __quit / post-quit

- `__quit` with valid id → `{ ok: true }`.
- `__query` after `__quit` → `isError=true` with `session '<id>' not found`.

## Rough edges

1. **Chevrotain default parse-error messages are noisy.** `?- @bad` returns
   a 30+ line message enumerating every possible token. Acceptable for a
   debug-shaped tool but could be tightened by overriding
   `parser.errors[0].message` or providing a custom error message provider.
   Not a blocker for step 7.

2. **Predicate query result shape — `rows: [{}]` for yes-no satisfaction.**
   When `?- φ` is satisfied, the response is `{ head: [], rows: [{}], count: 1 }`.
   The empty-object row is intentional ("witness exists with no projected
   variables") but might surprise consumers who expect a boolean field. Consider
   adding `satisfied: boolean` to the structured response in a future revision.

3. **Stderr "ready" line is verbose for empty server config.** The CLI prints
   `qualms-mcp: ready (prelude at … 0 story files configured)` even when no
   stories were specified. Harmless; could be quieter.

## Conclusion

All step-6 acceptance criteria pass. The end-to-end pipeline (parse → eval
→ tool result) is stable for the prelude-only configuration. Ready to write
external acceptance tests in step 7.

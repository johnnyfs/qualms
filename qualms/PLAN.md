# Qualms JS migration: first major milestone

## Context

Multi-pass design speculation produced a settled tool/grammar/scope/render shape (recorded below as "Design reference"). We now begin building. Target: a JavaScript implementation of the engine + an MCP server, replacing the existing Python prototype. The current `qualms/` and `curses/` directories move to `deprecated/` for reference; new code lives under `qualms/` and `mcp/` at the repo root. `godot/` is ignored.

This plan covers **first major milestone**: the engine, query DSL, prelude, and a session-aware MCP server with start/quit/query — manually prod-tested and covered by acceptance tests. Mutation tools, `__command`/`__play`, `__coauthor`, `def view` rendering, and Tier 2/Tier 3 work are explicitly out of scope for this milestone.

### Note on `def view`

Kept in the design reference; not implemented in this milestone (no rendering tool ships in step 1-7). Flagged for possible isolation/rename later — view rules are a player-POV ergonomic concern and may not belong in the same rule space as gameplay rules.

---

## Step 0 — Migration goals document

Before any code: write `qualms/MIGRATION.md` (path tentative) covering:

- **Why:** Python prototype has accumulated CLI/coauthor cruft mixing NOVA-specific assumptions with engine concerns. A clean rewrite anchors the engine on a four-layer scope model (prelude / game_definition / session_definition / session_state), a single grammar that does query + derivation + mutation duty, and a transactional MCP surface that ports cleanly to whatever frontend (Ink) we eventually build.
- **What's preserved:**
  - Story YAML format (modulo deliberate prelude tweaks: `IsPlayer` relation, `Item` kind).
  - Prelude semantics for traits / relations / actions / rules / kinds.
  - Coauthor concept (deferred to Tier 2; not implemented this milestone).
- **What's changing:**
  - Engine reimplemented in TypeScript (Node 20+).
  - Query/mutation surface is a new DSL with FOL + Cypher path patterns + Datalog-style named rules; structural meta-types live in the same query namespace.
  - MCP server is the canonical agent-facing surface; CLI is deferred.
  - Four-scope structural model with `__begin`/`__commit`/`__rollback` transactions; `__save` writes player progress separately from structural commits.
- **What's deferred:**
  - `def view` rendering and `__render` tool.
  - `__command`/`__play`/`__attempt`/`__coauthor` tools (Tier 2).
  - Mutation tools (`__begin`/`__commit`/`__rollback`/`__mutate`/`__diff`).
  - Inform-style addressing.
  - Live extensions vs co-authoring stricter rules (no changing what the player has seen).
  - Concurrent transactions across scopes.
  - JS port of `story_writer.py` (round-trip from runtime back to YAML).
  - Migration of stellar / wave_collapse content.
- **Goals statement:** measurable definition of "first milestone done" — see step 7.
- **Glossary:** prelude, game_definition, session_definition, session_state, scope, layer, AST, view rule.

Deliverable: `qualms/MIGRATION.md` reviewed and committed before step 1 starts.

---

## Step 1 — JS engine UML (minimal compliant)

**Deliverable.** TypeScript types + classes for the engine's compile-time and runtime shape, mirroring `qualms/core.py` minimally:

- **Compile-time / definition-time:** `TraitDefinition`, `RelationDefinition`, `ActionDefinition`, `RuleDefinition`, `KindDefinition`, `EntitySpec`, `GameDefinition`, plus the supporting `ParameterDefinition`, `FieldDefinition`, `TraitAttachment`.
- **Runtime:** `WorldState` (entities, trait fields, relations, facts, events, allocators), `Entity`, `TraitInstance`, `RulesEngine`, `ActionAttempt`, `ActionResult`.
- **Layer awareness:** `WorldState` and `GameDefinition` track which layer each definition / entity / fact came from (`prelude` | `game` | `session`). Lookups can return merged or layer-scoped views.

**Out of scope this step:** YAML loading, the rules engine's actual evaluation (stub `attempt` to return `unimplemented`), the query language.

**Verification.** Unit tests construct definitions and worldstates programmatically and assert structural integrity (trait fields type-check, relations reference valid traits, layer attribution preserved through merges).

**Decisions to lock at step start:**
- TypeScript with `"strict": true`. Node 20+. ESM.
- Test framework: vitest (recommended) or node:test.
- Package manager: pnpm or npm — pick one and stick to it.

---

## Step 2 — Query DSL: AST + evaluator

**Deliverable.** TypeScript AST types and evaluator for the query language operating directly on AST input (no parser yet).

- **AST shapes:** quantifiers (`exists`, `forall`), boolean ops (`and`, `or`, `not`), atoms (relation calls, trait-of, field access, equality, negation), path patterns (`-[R]->`, `-[R]->*`, `-[R]->+`, `<-[R]-`, `-[R1|R2]->`), comprehensions (`{ x | φ }`), named rules / queries (`reachable(a, b) :- ...`, `?- goal(?x)`).
- **Evaluator:** binds variables, walks the WorldState's relations and trait stores, expands derived relations by inlining their bodies (the bodies are themselves AST trees). Results are sets of variable bindings.
- **Meta queries:** structural objects (`Trait`, `Kind`, `Action`, `Relation`, `Rule`, `Rulebook`, `Entity`) addressable in the same namespace via engine-introspection relations (`uses`, `defines`, `instance_of`, etc.). Scope addressing: `Trait@prelude` / `Trait@game` / `Trait@session`; bare `Trait` = merged.

**Out of scope this step:** parser, mutation, view rules.

**Verification.** Build small WorldStates programmatically, run queries (as AST literals) against them, assert binding sets. Cover: ground relations; derived relations; transitive closures; comprehensions; quantifier scoping; meta-queries against introspection relations; scope addressing.

---

## Step 3 — Query DSL parser

**Deliverable.** A parser that takes a DSL string and produces the AST from step 2.

- Grammar covers: ASCII operators (`&`, `|`, `not`, `exists`, `forall`, `->`, `=`, `=~`, `like`), unicode equivalents (`∧`, `∨`, `¬`, `∃`, `∀`, `→`, `≠`), arrow path patterns, comprehensions, rule heads.
- Reasonable error messages with span info.

**Parser approach: Chevrotain.** Robust in-code parser library, no codegen step, mature, full unicode support. Build the grammar by composing parser methods in TypeScript — no separate `.peg`/`.g4` file, no build step. If a need surfaces that Chevrotain genuinely can't meet, swap to another in-code library (Ohm.js, ts-parsec); do not hand-roll.

**Unicode is a hard requirement.** Verify at step start that Chevrotain's tokenizer handles `∃ ∀ ∧ ∨ ¬ → ≠` cleanly alongside ASCII equivalents (`exists`, `forall`, `&`, `|`, `not`, `->`, `!=`). Both forms must produce the same AST.

**Verification.**
- Unit: DSL string → AST equals expected AST literal (comprehensive sample set covering every grammar production).
- Integration: parse-then-eval produces the same bindings as eval-on-literal-AST for the same query (round-trip through the parser doesn't change semantics).

---

## Step 4 — Prelude port + YAML loader

**Deliverable.**

- **YAML loader** (`qualms/yaml/`) reading prelude / story files into the engine's compile-time types from step 1.
- **Migrated prelude** at `qualms/prelude/core.qualms.yaml` — port of `stories/prelude/core.qualms.yaml`, with explicit changes:
  - Add `IsPlayer(actor)` top-level relation.
  - Add `Item` kind (Presentable + Relocatable).
  - Purge any legacy artifacts surfaced during the port (e.g., `SequenceComplete` if it's truly orphaned).
- **No NOVA prelude** in this milestone — start clean. Story content migration is deferred.
- **Schema validation:** loader rejects malformed input with clear errors; reports layer attribution on every loaded object.

**Verification.**
- Unit: YAML fragment → engine type, exhaustive on each YAML construct (trait def, relation def with each persistence kind, action, rule, kind, entity spec, fact, assertion).
- Integration: load the migrated prelude end to end; run a battery of DSL queries against the loaded definition (e.g., `{ k : Kind | uses(k, Presentable) }` should return `Thing`, `Place`, `Person`, `Item`; `{ r : Relation | r.id = "IsPlayer" }` should match).

---

## Step 5 — MCP server skeleton: start, quit, query

**Deliverable.** A working MCP server (`mcp/`) using the official `@modelcontextprotocol/sdk` (TypeScript) with three tools:

- `__start({ corePath, storyPaths? })` — loads `corePath` as protected prelude (read-only), loads any number of `storyPaths` as game_definition, returns `{ session_id }`. Initializes a `WorldState` and stores the session in process memory.
- `__quit({ session_id })` — tears down the session.
- `__query({ session_id, expr })` — `expr` is a DSL string; parser → AST → evaluator → bindings. Returns `{ bindings, count }`.

**Server CLI:**
```
qualms-mcp --core path/to/core.qualms.yaml [--story path/to/story.qualms.yaml ...]
```
(`--core` may be hard-required and pinned to `qualms/prelude/core.qualms.yaml` by default; story paths may be passed multiple times. Server enforces core as protected: this milestone has no mutation tools, so the protection is implicit; future steps must respect it explicitly.)

**Verification.**
- Unit: each tool's request/response handler tested in isolation against a stub session manager.
- Unit: the parser-eval pipeline invoked through the tool layer returns bindings matching step 3/4 fixtures.

---

## Step 6 — Manual prod-test against running server

**Deliverable.** Hand-run the server with the migrated prelude (no story files) and exercise `__start` / `__query` / `__quit` end-to-end. Document any rough edges discovered.

Sample exercises (these become the seed for step 7's acceptance suite):
- `__start({ corePath: "qualms/prelude/core.qualms.yaml" })` — confirm session id returned, no errors.
- `__query`: `{ k : Kind | uses(k, Presentable) }` — expect `Thing, Place, Person, Item`.
- `__query`: `{ t : Trait | exists r : Relation. defines(t, r) }` — expect every trait that owns a relation.
- `__query`: `{ r : Relation@prelude | r.id =~ /^Can/ }` — expect `CanTouch`, `CanSee`.
- `__quit({ session_id })` — confirm clean shutdown.

**No story files yet** — the prelude alone is enough to prove the loader, parser, evaluator, and server.

**Verification.** Running the above by hand produces sensible output; rough-edge log captured.

---

## Step 7 — External acceptance tests

**Deliverable.** A test harness that spawns the server as a subprocess, drives it via the MCP protocol, and asserts on responses. Covers:

- Lifecycle: start with valid core succeeds; start with missing core fails cleanly; quit releases resources; query on dead session errors meaningfully.
- Query correctness: a representative query battery (the step-6 exercises plus more) produces stable, expected bindings.
- Layer attribution: `Trait@prelude` results match the prelude file; `Trait@game` empty when no story loaded.
- Error surfaces: malformed DSL produces parse errors with span info; references to unknown relations produce evaluator errors.

**Definition of "first milestone done":** all step-7 acceptance tests pass headlessly in CI (or local equivalent), prelude-only configuration. From here, subsequent milestones add story-file loading + first mutation tools, then `__render` + `def view`, then `__command`/`__play`, etc.

---

## Repo layout (target after this milestone)

```
qualms/                         # new TypeScript engine + prelude
  MIGRATION.md
  package.json
  tsconfig.json
  src/
    core/                       # UML types from step 1
    yaml/                       # loader from step 4
    query/
      ast.ts                    # step 2
      eval.ts                   # step 2
      parser.ts                 # step 3
  prelude/
    core.qualms.yaml            # migrated, step 4
  test/
    unit/
    integration/
mcp/                            # MCP server, step 5
  package.json
  src/
    server.ts
    session.ts
    tools/
      start.ts
      quit.ts
      query.ts
  test/
    unit/
    acceptance/                 # step 7
deprecated/
  qualms/                       # old Python engine (moved before step 1)
  curses/                       # old Python CLI (moved before step 1)
godot/                          # ignored
stories/                        # untouched in this milestone
```

## Decisions to lock before step 1

- **TypeScript, Node 20+, ESM.**
- **Package manager:** pnpm (recommended) or npm.
- **Test framework:** vitest (recommended) or node:test.
- **Repo style:** monorepo with `qualms/` and `mcp/` as separate workspaces (pnpm/npm workspaces) — they will share types.
- **MCP SDK:** `@modelcontextprotocol/sdk` TypeScript bindings.
- **Parser approach:** Chevrotain (in-code parser library, no codegen, unicode-capable). Never hand-rolled.

If any of these are wrong defaults, redirect at step 0.

---

# Design reference (from prior speculation passes — kept for context)

## Four-layer structural model

| Layer | Edit path |
|---|---|
| prelude | File-edit only (coding agent). Off-limits to MCP. |
| game_definition | `commit(transaction_id, scope=story)` → `story.qualms.yaml`. |
| session_definition | `commit(transaction_id, scope=session)` → save-file overlay. |
| session_state | Live `WorldState`; mutated by actions; `save(session_id)` snapshots. |

Live world = `prelude ⊕ game ⊕ session_def` (definitions) + `session_state` (facts/fields).

## Tool surface (full target — only step 5 subset implemented this milestone)

```
Lifecycle:    __start, __quit, __save
Play-scoped:  __render, __command, __play, __attempt
Structural:   __begin, __commit, __rollback, __mutate, __diff
Read:         __query, __expand
Coauthor:     __coauthor                 (Tier 2)
```

## Mutation grammar (`def`/`undef`, deferred past this milestone)

```
assert R(a, b, ...)        retract R(a, b, ...)        a.f := value
def trait T {…}            def entity x : K {…}        def relation R(…) {…}
def action A(…) {…}        def kind K {…}              def rule R in B {…}
def rulebook B {…}         def view <name> {…}
undef <kind> <name>
```

Effect lists reuse `assert`/`retract`/`:=`/`emit`. Same grammar for queries / derivations / rule guards / rule effects / agent mutations.

## Meta-types in the query namespace

`Trait`, `Kind`, `Action`, `Relation`, `Rule`, `Rulebook`, `Entity` — first-class. Engine introspection relations: `uses(kind, trait)`, `defines(trait, field|relation|action)`, `defines(rulebook, rule)`, `instance_of(entity, kind)`. Scope: `Type@prelude|@game|@session`; bare = merged.

## Settled

- Structural commits during play: rely on core validation. Play continues as long as `IsPlayer(...)` binds to a live actor.
- `assert`/`retract` destinations vary by transaction context (story / session_def) or in-action effect (session_state).
- In-game effects flow through actions to session_state. Authoring agents use `__begin/__commit`.
- `__command` strict structured. `__play` does fuzzy NL (verb prefix + name match scoped to current view).
- Rendering is prelude-specified via `def view` rules; no universal algorithm. View rules may be isolated/renamed later — they're player-POV ergonomic concerns, not gameplay rules.

## Open speculation (after first milestone)

1. Path-finding queries combining physical + story-tree reachability.
2. View rule emit primitives (full set), selection / priority semantics, structured-vs-string emit semantics for non-text frontends.
3. Inform-style addressing (`X, do Y` rebinds actor) — prelude-resident.
4. Live-extension stricter rules (no changing what the player has seen).

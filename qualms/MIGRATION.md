# Qualms migration: Python → TypeScript

This document records the goals, scope, and constraints of the rewrite. It is the canonical reference for what changed, what was preserved, and what was deliberately deferred. The previous Python implementation lives at `deprecated/qualms/` and `deprecated/curses/` for reference.

## Why we are rewriting

The Python prototype proved out the core ideas — a trait/relation/action/rule engine, a story authoring layer, a coauthoring agent — but accumulated several structural problems that make further work expensive:

1. **CLI and engine are tangled.** `deprecated/curses/dark_qualms_story.py` is ~6700 lines mixing display logic, command parsing, save/load, the legacy NOVA-shaped game (`StoryWorld`/`GameState`/`Ship`/`Orbital`/`System`), and a parallel "generic CLI" path. Cleaning the tangle in place produces cosmetic wins; the deeper problem is that NOVA-specific assumptions leak through both the interactive surface and the agent tools.

2. **Authoring vocabulary is anchored to one domain.** The prelude/nova-prelude split was meant to keep gameplay-genre concepts out of the engine. In practice, the active CLI hardcodes 24+ NOVA verbs and the coauthor agent has 14 tools named for NOVA primitives (`create_destination`, `create_npc`, `create_ship`). The engine itself is generic; the surfaces around it are not.

3. **No transactional structural editing.** The coauthor mutates a YAML dict in memory, validates, and saves. There is no scope distinction between schema-level changes (apply to all future players) and run-only changes (this player's session). There is no separation between "save player progress" and "commit a structural change". Both concerns share one save operation.

4. **No expressive query surface.** The engine exposes `WorldState.test(relation, args)` and per-tool list/get methods; agents cannot ask compositional questions. There is no surface for structural meta-queries ("which kinds use trait X").

5. **Frontend target has shifted.** The interactive surface should be Ink/JS, not curses. Continuing to invest in Python interactive code is throwaway work.

The rewrite addresses all five at once by reimplementing the engine in TypeScript, anchoring it on a four-layer scope model, exposing a single DSL for queries and structural mutations, and shipping an MCP server as the canonical agent surface.

## Architectural moves

### Four-tier structural model (modules)

The live world is composed of three structural modules plus a runtime tier, each with its own edit path:

| Module | What lives there | Edit path |
|---|---|---|
| **prelude** | Universal traits, relations, actions, kinds, rulebooks shared across all stories. | File-edit only by the coding agent. **Off-limits to MCP.** |
| **game** | Per-story schema additions, kinds, entity initial states, story-specific rules. The `story.qualms.yaml` artifact. | `commit(transactionId)` after `begin({ module: "game", targetPath })` writes the game-module slice to the target YAML on disk. |
| **session** | Per-run structural overlay invented for this player (e.g., agent-spawned NPCs, scenario-specific traits). | `commit(transactionId)` after `begin({ module: "session" })` finalizes the overlay in memory; persisted later on `save(sessionId)`. |
| **session_state** (runtime tier) | The live `WorldState` — facts, fields, events, allocators. Mutated by actions during play. | `command`/`play` apply actions; `save(sessionId)` snapshots. |

At load, the live world is `prelude ⊕ game ⊕ session` for definitions plus `session_state` for runtime facts. Two distinct save operations, two destinations: `save(sessionId)` writes player progress (`session module + session_state`); `commit` after a game-module `begin` writes structural changes to disk.

The "module" framing replaces the prior "layer" terminology — same concept, better word for what the architecture is heading toward (named, importable units of definition). Generalization to arbitrary named modules with `using` imports is deferred.

### One grammar, multiple roles

A single DSL serves five purposes:

1. **Queries** — `?- ∃ k. uses(k, Equipment)`
2. **Derived relation bodies** — `CanTouch(a, t) :- (a : Relocatable ∧ a.location = t.location) ∨ CarriedBy(a, t) ∨ Aboard(a, t.location)`
3. **Rule guards** — `requires : ∃ x. CarriedBy(actor, x)`
4. **Rule effects** — `effects : assert Visited(actor, destination)`
5. **Agent mutations** — `mutate(tx_id, "def entity test : Item { name = 'Test' }")`

The grammar combines first-order logic, Cypher-style path patterns over binary relations, and Datalog-style named rules. Both ASCII and unicode mathematical operators are supported and produce the same AST. Statement-level heads (`assert`, `retract`, `:=`, `def`, `undef`) distinguish queries from mutations; expression bodies are uniform.

### Structural objects in the query namespace

Traits, kinds, actions, relations, rules, rulebooks, and entities are all first-class queryable types. The engine exposes introspection relations (`uses(kind, trait)`, `defines(trait, field)`, `instance_of(entity, kind)`, etc.) so that meta-queries use the same grammar as world queries. A single composition can ask "entities of kinds that use trait X" without crossing a tool boundary. Module addressing (`Trait@prelude`, `Trait@game`, `Trait@session`; bare `Trait` = merged) targets specific modules when needed.

### MCP server is the agent surface

There is no CLI in this milestone. The agent-facing surface is a stateful MCP server. Sessions hold a live `WorldState` and an authoring workspace. Tools are deterministic and structured (Tier 1); LLM-mediated wrappers (`__play`, `__coauthor`) are deferred to a later milestone. During Tier 1 development, Claude-in-conversation acts as the LLM driver, refining the deterministic surface through use before any agent prompt is committed to code.

## What's preserved

- **Story YAML format**, with deliberate prelude additions and removals:
  - **Added**: `IsPlayer(actor)` top-level relation (universal "who is the player" entry point) and the `Item` kind (Presentable + Relocatable).
  - **Removed**: `Visited` relation and the `core-memory` rulebook — story-level memory is a story concern, not a universal primitive. `Aboard` relation absorbed into `At` + `CarriedBy` in `CanTouch`'s derivation. `SequenceComplete` removed as orphaned.
  - **Collapsed**: `persistence: current | remembered | both` is gone. A relation is **stored** (no `get` body) or **derived** (has `get`). The single `WorldState.relations` Map replaces the prior `currentRelations` / `rememberedRelations` split.
- **Prelude semantics for traits, relations, actions, rules, kinds.** The grammar is new; the model is the same.
- **Coauthor concept.** Deferred to Tier 2; not implemented in this milestone.
- **`stories/`.** Untouched in this milestone. Story content migration follows once the engine and MCP surface stabilize.

## What's changing

- **Engine reimplemented in TypeScript** (Node 20+, ESM, strict mode).
- **Repo layout:** `deprecated/qualms/`, `deprecated/curses/` for reference; new `qualms/` (TypeScript engine + prelude) and `mcp/` (MCP server) at the repo root. `godot/` ignored.
- **Query/mutation surface:** new DSL with FOL + Cypher path patterns + Datalog-style named rules; structural meta-types in the same query namespace; ASCII/unicode parity.
- **Module-aware structural model** with `begin`/`commit`/`rollback`/`mutate`/`diff` transactions (shipped in milestone 2); `save` writes player progress separately from structural commits (deferred). `begin({ module: "game", targetPath })` opens a transaction whose `commit` writes the game module slice back to the target YAML on disk; `begin({ module: "session" })` finalizes the session overlay in memory until `save` lands. The earlier `scope: "story" | "session"` parameter is gone — transactions name their target module directly.
- **Storage class collapse.** Relations have no `persistence` field; they are stored by default and derived when a `get` body is present. `WorldState` keeps a single relations Map. Story-level memory patterns (e.g. tracking visited locations) belong in story files, not the prelude.
- **No CLI** in this milestone. Future frontend will be Ink/JS, not curses.
- **No NOVA-specific surface anywhere.** The prelude is genuinely universal; story-specific vocabulary lives in story files.

## What's deferred (not in this milestone)

- `def view` rendering and the `__render` tool. View rules may also be relocated outside the rule space later — they are player-POV ergonomic concerns, not gameplay rules.
- `__command`, `__play`, `__attempt`, `__coauthor` tools (Tier 2 LLM-mediated and Tier 1 play-scoped).
- `save` — gameplay save (snapshots `session_state`). Session-module `commit` finalizes the session overlay in memory; persistence to disk happens later via `save`.
- `__expand` (definition introspection by name).
- Inform-style addressing (`X, do Y` rebinds actor) — prelude-resident, later.
- Live-extension stricter rules ("no changing what the player has seen without an in-game event"). Until then, core validation (no hanging refs) is the only safety on structural commits during play.
- Concurrent transactions across modules; for now, one active transaction per session.
- **Module generalization.** The three modules (`prelude`/`game`/`session`) are fixed in this milestone. Future work generalizes to arbitrary named modules per file with `using <module>` imports and runtime module creation.
- Migration of stellar / wave_collapse story content.
- NOVA prelude port. The current milestone ships only a clean core prelude.
- Functional amend layer for transactions. Snapshot-based rollback (deep-clone of `GameDefinition` + `WorldState` at `begin`) is provisional; the intended endpoint is a base-ref + delta merged on read so cost scales with transaction size and parallel transactions across scopes become possible.
- **`was P` operator** for demand-driven memory tracking. Until then, story-level memory is expressed as ordinary stored relations asserted by story rules (the same shape `Visited` had in the old prelude, but story-authored).

## Goals statement: definition of "first milestone done"

The first major milestone is complete when **all of the following hold**:

1. The TypeScript engine UML compiles and unit-tests pass: definitions can be constructed and merged across layers, and structural integrity is enforced by the type system and runtime checks.
2. The query DSL has a working evaluator over runtime `WorldState` operating on AST input. Unit tests cover ground relations, derived relations with inlining, transitive closures, comprehensions, quantifier scoping, meta-queries against introspection relations, and scope addressing.
3. The query DSL has a Chevrotain-based parser. ASCII and unicode forms produce identical ASTs. Round-trip tests confirm parse-then-eval matches eval-on-literal-AST for the same query text.
4. A YAML loader reads the migrated core prelude into engine types with full layer attribution.
5. The migrated core prelude includes the `IsPlayer(actor)` relation and the `Item` kind (Presentable + Relocatable). Legacy artifacts surfaced during the port are removed.
6. An MCP server exposes three tools: `__start`, `__quit`, `__query`. The server takes a required `--core` path and zero or more `--story` paths.
7. The server runs the migrated prelude, accepts queries against it, and returns correct bindings for a documented sample suite.
8. A subprocess-driven acceptance test suite passes headlessly. Coverage: lifecycle (start/quit, missing-core failure, dead-session error); query correctness (the sample suite plus extensions); layer attribution; error surfaces (parse errors with span info; unknown-relation evaluator errors).

When all eight hold, the milestone is done. Subsequent milestones add story-file loading and the first mutation tools, then `def view` + `__render`, then `__command`/`__play`, then `__coauthor`.

## Glossary

- **Module.** One of {prelude, game, session}. Every definition and entity tracks the module it came from. Module attribution is preserved through merges and surfaces in `Type@module` query notation. (Was previously called "layer" — same concept, renamed in milestone 2 to set up eventual module-graph generalization.)
- **Prelude.** Universal schema module. Defines the core traits, relations, actions, rules, kinds usable by any story. Edited only by file edit; never writable through MCP.
- **Game.** Per-story schema additions and initial state. Lives in a `story.qualms.yaml` file. Mutations target it via `begin({ module: "game" })`; `commit` writes the slice back to disk.
- **Session.** Per-run structural overlay. Schema/entity additions invented during a player's session that affect only this run. Mutations target it via `begin({ module: "session" })`; persisted later in the save file by `save`.
- **Session state.** The live `WorldState` — entity records, trait field values, asserted relations, facts, events, allocators. Mutated by action effects during play. Not a structural module; the runtime tier.
- **AST.** Abstract syntax tree. The query DSL parser produces an AST; the evaluator consumes one. Tools that take "expressions" accept either AST objects (programmatic callers) or DSL strings (parser-then-eval).
- **View rule.** A `def view` rule in the prelude that emits formatted text or structured nodes from world state for player-POV rendering. Not implemented in this milestone; flagged for possible isolation/rename later.
- **Tier 1 / Tier 2 / Tier 3.** Tool layering. Tier 1 = deterministic primitives; Tier 2 = LLM-mediated wrappers (`play`, `coauthor`); Tier 3 = real frontend (Ink) and concurrent autonomous agents.
- **Meta-type.** A reflective type for a structural object: `Trait`, `Kind`, `Action`, `Relation`, `Rule`, `Rulebook`, `Entity`. Queryable in the same namespace as world entities.
- **Introspection relation.** A relation exposed by the engine that talks about structure rather than state: `uses(kind, trait)`, `defines(trait, field)`, `instance_of(entity, kind)`, etc.

## Locked decisions

- TypeScript, Node 20+, ESM, `"strict": true`.
- pnpm workspaces. `qualms/` and `mcp/` are separate packages sharing types.
- vitest for tests.
- `@modelcontextprotocol/sdk` for the MCP server.
- Chevrotain for the query DSL parser. In-code grammar; no codegen step. Full unicode support for math operators.

## Out-of-scope cleanup

`pyproject.toml`, `uv.lock`, `tests/`, `examples/`, `story_declarative.txt`, and `run.sh` / `run-dev.sh` at the repo root remain in place for now. They reference the deprecated Python paths and are non-functional after the move; they will be removed or replaced as the new structure matures. `stories/` and `specs/` stay untouched in this milestone.

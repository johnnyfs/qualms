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

### One grammar, three surfaces

A single DSL is the canonical authoring surface for all three:

1. **Module files** (`.qualms`) — sequence of `def` statements that load into a `GameDefinition` at the file's module attribution.
2. **Mutations** through the MCP `mutate` tool — `def`/`undef`/`assert`/`retract`/`:=` statements applied transactionally.
3. **Queries** through the MCP `query` tool — `query { vars | φ };`, `exists { φ };`, `show <kind> <name>;`, plus named-predicate definitions for inlinable subpatterns.

The grammar combines first-order logic, Cypher-style path patterns over binary relations, and Datalog-style named rules. Both ASCII and unicode mathematical operators are supported and produce the same AST. Statement-level verbs (`def`, `undef`, `query`, `exists`, `show`, plus `assert`/`retract`/`:=` as standalone or effect-list members) distinguish read from write at the wire level. Body conventions are uniform: brace-delimited, `;`-separated clauses; expression bodies in `?- φ` form; effect lists in `[ effect; effect; ]` form.

DSL examples:

```
# Trait with field declarations and a nested derived relation
def trait Relocatable {
  location: Location? = null;
  def relation At(subject: Relocatable, location: Location) {
    get: subject.location = location;
    set: [ subject.location := location; ];
  }
  def action Move(actor: Actor? = null, subject: Relocatable, destination: Location) {
    requires: true;
    effects: [ assert At(subject, destination) ];
  }
}

# Container with a set-valued field and a stored derived relation
def trait Container {
  contents: set<Relocatable> = {};
  def relation Contains(container: Container, item: Relocatable) {
    get: item in container.contents;
    set: [ container.contents += item; ];
  }
}

# Kind with colon-separated trait list and field overrides
def kind Foe: Combatant, Presentable {
  Presentable.name = "Foe";
};

# Entity with kind reference, qualified field overrides, metadata
def entity grunt: Foe {
  Combatant.hp = 5;
  Presentable.name = "Grunt";
  metadata.spawned = true;
};

# Read surface
query { e | e : Entity & instance_of(e, "Foe") };
exists { ∃ r : Relation. r.id = "IsPlayer" };
show trait Presentable;
```

### Structural objects in the query namespace

Traits, kinds, actions, relations, rules, rulebooks, and entities are all first-class queryable types. The engine exposes introspection relations (`uses(kind, trait)`, `defines(trait, field)`, `instance_of(entity, kind)`, etc.) so that meta-queries use the same grammar as world queries. A single composition can ask "entities of kinds that use trait X" without crossing a tool boundary. Module addressing (`Trait@prelude`, `Trait@game`, `Trait@session`; bare `Trait` = merged) targets specific modules when needed.

### MCP server is the agent surface

There is no CLI in this milestone. The agent-facing surface is a stateful MCP server. Sessions hold a live `WorldState` and an authoring workspace. Tools are deterministic and structured (Tier 1); LLM-mediated wrappers (`__play`, `__coauthor`) are deferred to a later milestone. During Tier 1 development, Claude-in-conversation acts as the LLM driver, refining the deterministic surface through use before any agent prompt is committed to code.

## What's preserved

- **Prelude semantics** for traits, relations, actions, rules, kinds, rulebooks, entities. The grammar and file format are new (DSL v2, `.qualms`); the model is the same.
- **Coauthor concept.** Deferred to Tier 2; not implemented in this milestone.
- **`stories/`.** Untouched in this milestone. Story content migration follows once the engine and MCP surface stabilize. Stories migrate by hand from `.qualms.yaml` to `.qualms` when they're touched.

### Prelude additions and removals (cumulative across milestones)

- **Added**: `IsPlayer(actor)` top-level relation (universal "who is the player" entry point) and the `Item` kind (Presentable + Relocatable).
- **Removed**: `Visited` relation and the `core-memory` rulebook — story-level memory is a story concern, not a universal primitive. `Aboard` relation absorbed into `At` + `CarriedBy` in `CanTouch`'s derivation. `SequenceComplete` removed as orphaned.
- **Collapsed**: `persistence: current | remembered | both` is gone. A relation is **stored** (no `get` body) or **derived** (has `get`). The single `WorldState.relations` Map replaces the prior `currentRelations` / `rememberedRelations` split.

## What's changing

- **Engine reimplemented in TypeScript** (Node 20+, ESM, strict mode).
- **Repo layout:** `deprecated/qualms/`, `deprecated/curses/` for reference; new `qualms/` (TypeScript engine + prelude) and `mcp/` (MCP server) at the repo root. `godot/` ignored.
- **DSL v2 is the single authoring surface.** `.qualms` files (brace-delimited, `;`-separated statements) replace `.qualms.yaml`. The mutation surface, query surface, file format, and `show` definition retrieval all share one grammar. The legacy YAML loader, emitter, and predicate translator are gone.
- **Module-aware structural model** with `begin`/`commit`/`rollback`/`mutate`/`diff` transactions. `save` writes player progress separately from structural commits (deferred). `begin({ module: "game", targetPath })` opens a transaction whose `commit` writes the game-module slice back to a `.qualms` file on disk; `begin({ module: "session" })` finalizes the session overlay in memory until `save` lands. Module name (`prelude`/`game`/`session`) is passed directly — no `scope` parameter.
- **Storage class collapse.** Relations have no `persistence` field; they are stored by default and derived when a `get` body is present. `WorldState` keeps a single relations Map. Story-level memory patterns (e.g. tracking visited locations) belong in story files, not the prelude.
- **No CLI** in this milestone. Future frontend will be Ink/JS, not curses.
- **No NOVA-specific surface anywhere.** The prelude is genuinely universal; story-specific vocabulary lives in story files.
- **`play` tool — runtime action execution.** `play({ sessionId, action, args })` resolves an action by id, binds parameters from `args`, evaluates `requires` against current state, then applies the action's effects (assert/retract/`:=`/`+=`/`-=`/emit) to live `WorldState`. Returns emitted events. `assert R(...)` on a *derived* relation runs R's `set:` clause with call args bound to R's parameters — so the prelude's `Take` (effect: `assert CarriedBy(actor, item)`) actually moves the item via `CarriedBy.set` → `At.set` → `subject.location := location`. **Rules engine (before/during/after firing) is not implemented; only the action's own effects run.**
- **Mutation surface: derived-assert expansion.** `assert R(...)` via `mutate` now expands R's `set:` clause the same way `play` does (with the call args bound to R's declared parameters). Story setup reads naturally — `assert At(player, cell_a)` lands as `player.location := cell_a` without the author having to spell it out. Recursion is bounded (depth 16) to fail loudly on pathologically circular set: clauses.
- **Prelude: generic `Locked(location)` relation.** Stored relation, asserted by stories to mark a location as locked. The prelude's `Use` action retracts `Locked(target)` by default and emits a brief acknowledgement; `Move` now requires `Path(subject.location, destination) & not Locked(subject.location)` so movement respects the path graph and doesn't leak out of locked sources.

### DSL polish (M4)

- **Optional trailing `;`** after body-bearing defs. `def trait Foo { … }` is legal; body-less statements (`def kind X: T1, T2;`) still require `;`.
- **Casing-based type discrimination.** Lowercase identifiers (`str`, `int`, `bool`, `set<T>`) are primitives; PascalCase identifiers (`Location`, `Actor`, `Item`) are entity references. The `ref<>` wrapper is gone.
- **Auto-resolved `param.field`** inside relation/action bodies — the parameter's declared trait type owns the field. Use the qualified `param.Trait.field` form for cross-trait reads. Kind/entity field overrides still require `Trait.field = value` qualifiers.
- **`?-` markers dropped** from clause bodies (`get:`, `requires:`, `guard:`). Body type is declared by the clause keyword. An optional `: <typeRef>` return-type annotation on relation/action heads parses but is documentation-only.
- **`default` → `effects`** on actions. The clause matches rules' `effects:`.
- **`set<T>` first-class collection type** with the operators `in` (membership), `+=` (add), `-=` (remove). Set literals are `{}` (empty) or `{a, b, c}` (populated). `Container.contents: set<Relocatable>` in the prelude exercises the model.

## What's deferred (not in this milestone)

- `def view` rendering and the `__render` tool. View rules may also be relocated outside the rule space later — they are player-POV ergonomic concerns, not gameplay rules.
- `__command`, `__attempt`, `__coauthor` tools (Tier 2 LLM-mediated and Tier 1 play-scoped). (`play` is implemented as a Tier 1 deterministic primitive — no LLM mediation.)
- **Rules engine.** `def rule … in <rulebook>` parses and stores, but matched-action firing (before/during/after/instead phases, priority, control) is not implemented. `play` runs only the invoked action's own effects.
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
- **Game.** Per-story schema additions and initial state. Lives in a `story.qualms` file. Mutations target it via `begin({ module: "game" })`; `commit` writes the slice back to disk.
- **Module file (`.qualms`).** A DSL v2 text file containing a sequence of `def` statements. Loaded into a `GameDefinition` at the file's module attribution via `loadDslFile` / `loadDslText`.
- **Session.** Per-run structural overlay. Schema/entity additions invented during a player's session that affect only this run. Mutations target it via `begin({ module: "session" })`; persisted later in the save file by `save`.
- **Session state.** The live `WorldState` — entity records, trait field values, asserted relations, facts, events, allocators. Mutated by action effects during play. Not a structural module; the runtime tier.
- **AST.** Abstract syntax tree. The query DSL parser produces an AST; the evaluator consumes one. Tools that take "expressions" accept either AST objects (programmatic callers) or DSL strings (parser-then-eval).
- **View rule.** A `def view` rule in the prelude that emits formatted text or structured nodes from world state for player-POV rendering. Not implemented in this milestone; flagged for possible isolation/rename later.
- **Tier 1 / Tier 2 / Tier 3.** Tool layering. Tier 1 = deterministic primitives; Tier 2 = LLM-mediated wrappers (`play`, `coauthor`); Tier 3 = real frontend (Ink) and concurrent autonomous agents.
- **Meta-type.** A reflective type for a structural object: `Trait`, `Kind`, `Action`, `Relation`, `Rule`, `Rulebook`, `Entity`. Queryable in the same namespace as world entities.
- **Introspection relation.** A relation exposed by the engine that talks about structure rather than state: `uses(kind, trait)`, `defines(trait, field)`, `instance_of(entity, kind)`, etc.
- **`set<T>`.** First-class collection type for trait fields. Stored as a JS `Set`. Mutated with `target += element` / `target -= element`; tested with `element in target`. Empty default is `{}`; populated literal is `{a, b, c}`.
- **Casing convention.** Lowercase identifier in a type position = primitive (`str`, `int`, `bool`, `set<…>`); PascalCase identifier = entity reference (`Location`, `Actor`, `Item`). Trailing `?` marks an optional entity ref.

## Locked decisions

- TypeScript, Node 20+, ESM, `"strict": true`.
- pnpm workspaces. `qualms/` and `mcp/` are separate packages sharing types.
- vitest for tests.
- `@modelcontextprotocol/sdk` for the MCP server.
- Chevrotain for the DSL parser. In-code grammar; no codegen step. Full unicode support for math operators.
- DSL v2 (`.qualms`) is the single authoring surface for files, mutations, queries, and definition retrieval. No alternative file format ships.

## Out-of-scope cleanup

`pyproject.toml`, `uv.lock`, `tests/`, `examples/`, `story_declarative.txt`, and `run.sh` / `run-dev.sh` at the repo root remain in place for now. They reference the deprecated Python paths and are non-functional after the move; they will be removed or replaced as the new structure matures. `stories/` and `specs/` stay untouched in this milestone.

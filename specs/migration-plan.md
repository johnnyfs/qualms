# Migration Plan

This plan moves the current JSON/curses prototype toward the rules engine and YAML schema without breaking the playable loop in one large rewrite.

The migration has two tracks:

- A. Change current story data into compliant YAML with a nova-like Qualms prelude plus story content.
- B. Change the parser and curses engine to run through the new runtime model.

Both tracks should start by locking down current behavior with validation and regression tests.

## Current State

The maintained runtime is `curses/dark_qualms_story.py`.

Current data shape:

- Root `start_system`, optional `start_location`, and `systems`.
- `System` has `id`, `name`, `star_type`, `description`, `position_au`, `hops`, and `orbitals`.
- `Orbital` has `id`, `name`, `type`, `description`, optional `parent`, optional default landing path, and `landing_options`.
- `LandingOption` has destination-like fields plus nested `objects`, `npcs`, `ships`, `before`, `sequences`, and child `destinations`.
- `StoryObject`, `NPC`, and `Ship` each carry custom interaction lists and custom rule fragments.
- Current state is stored across ad hoc fields such as `facts`, `inventory`, `equipment`, `object_locations`, `ship_locations`, `boarded_ship_id`, and `player_ship_id`.

Current behavior to preserve during migration:

- Recursive destination navigation.
- Numbered interaction choices, including one menu entry per object/NPC/ship interaction.
- `before` rules with `when`, `unless`, message, and `on_complete`.
- `use_rules` on inventory objects.
- Destination sequences gated by facts.
- Inventory take/examine/use/equip.
- Ship visibility, boarding, control, takeoff, orbit, landing, and default landing paths.
- System hops, reciprocal hop validation, and hop distance validation.
- Editor add/edit/delete flows and reload-preserving-state behavior.

## Phase 0: Behavioral Baseline

Before changing the model, add regression coverage for the current implementation.

Deliverables:

- A test runner, probably `pytest`, for pure loader/state/action functions.
- Golden validation for `stories/stellar/story_systems.json`, `examples/blank/story_systems.json`, and `examples/sol-proof/story_systems.json`.
- Golden `--dump` snapshots for the same stories.
- Unit tests around the current interaction helpers.

Recommended tests:

- `load_world` accepts all current stories.
- `load_world` rejects duplicate system ids, duplicate orbital ids, unknown moon parents, non-reciprocal hops, over-distance hops, invalid start locations, and invalid interactions.
- `initial_game_state` starts in the same system/orbital/destination as today.
- `destination_path_by_ids` maps nested destination ids correctly.
- `visible_objects_for_destination`, `visible_npcs_for_destination`, and `visible_ships_for_destination` honor `visible_when` and `visible_unless`.
- `handle_interaction_choice` preserves current Take behavior, including inventory insertion and object location changes.
- `use_item_on_target` preserves matching `use_rules`, messages, and `on_complete` facts.
- `advance_sequence` applies sequence outcomes only after all messages are advanced.
- `state_has_fact` preserves special cases for equipment and ship facts.
- `board_ship_at_destination`, `take_off_from_destination`, and `land_boarded_ship` preserve ship state transitions.
- `reload_world_preserving_state` preserves location, inventory ids, ship locations, and controlled/boarded ship where possible.

The first migration checkpoint is: tests pass and `./run.sh --validate` still passes.

## Track A: Story Data Migration

### A1. Create a Core Prelude

Create `stories/prelude/core.qualms.yaml` with genre-agnostic primitives:

- Traits: `Presentable`, `Location`, `Relocatable`, `Container`, `Portable`, `Equipment`, `Actor`, `Usable`, `Ownable`.
- Relations: `At`, `Contains`, `CarriedBy`, `Equipped`, `Named`, `Visible`.
- Actions: `Name`, `Examine`, `Move`, `Take`, `Drop`, `Use`, `Equip`, `Unequip`.
- Kinds: `Thing`, `Person`, `Place`.

Guideline:

- `At` should be backed by `Relocatable.location`.
- `Contains(container, item)` should be derived from `At(item, container)` unless a later prelude proves a separate containment model is needed.
- `Take` should be an action whose default behavior asserts `CarriedBy(item, actor)` or `At(item, actor_inventory_location)`, depending on the inventory prelude.

### A2. Create a Nova-Like Qualms Prelude

Create `stories/prelude/nova-qualms.qualms.yaml` importing the core prelude.

Define traits:

- `SystemPosition` for 2D map coordinates.
- `OrbitalBody` for planet/moon/station data.
- `Orbiting` or `ChildOrbital` for moon parent structure.
- `Jumpable` for system-to-system movement.
- `Vehicle` for ship travel.
- `Boardable` for ships and other enterable vehicles.
- `Port` or `Dockable` if landing/takeoff needs port-specific behavior.

Define relations:

- `Hop(system, other_system)`.
- `Orbiting(orbital, system)`.
- `MoonOf(moon, parent_orbital)`.
- `DockedAt(ship, destination)`.
- `InOrbit(ship, orbital)`.
- `ControlledBy(ship, actor)`.

Define actions:

- `Jump(actor, ship, destination_system)`.
- `Approach(actor, ship, orbital)`.
- `Land(actor, ship, destination)`.
- `TakeOff(actor, ship)`.
- `Board(actor, ship)`.
- `Disembark(actor, ship)`.

Define kinds:

- `System`.
- `Planet`.
- `Moon`.
- `Station`.
- `Destination`.
- `Ship`.
- `NPC`.
- `StoryObject`.
- `Player`.

Nova-like constraints should live here, not in the genre-agnostic core:

- Hop links must be reciprocal.
- Hop distance must not exceed the configured short-hop limit.
- Moon orbitals must have a parent.
- Curses menus currently support no more than 9 choices.

### A3. Decide Canonical Entity IDs

Flatten nested JSON objects into globally unique entity ids.

Recommended stable id format:

```text
system_id
system_id/orbital_id
system_id/orbital_id/destination_id
system_id/orbital_id/destination_id/object_id
system_id/orbital_id/destination_id/npc_id
system_id/orbital_id/destination_id/ship_id
```

The visible authored `id` can remain a field on an `Identified` or `EditorMetadata` trait if the editor needs local ids. The runtime `Entity.id` should be globally unique.

### A4. Convert Current JSON To YAML

Write a converter that reads the current `story_systems.json` and emits:

- `stories/stellar/story.qualms.yaml` for entities, assertions, facts, and rules.
- Optional split files later, such as `systems.qualms.yaml`, `destinations.qualms.yaml`, and `items.qualms.yaml`, once the single-file conversion is stable.

Mapping:

- `System` JSON objects -> `kind: System` entities.
- `Orbital` JSON objects -> `kind: Planet`, `kind: Moon`, or `kind: Station` entities.
- `LandingOption` JSON objects -> `kind: Destination` entities.
- `StoryObject` JSON objects -> `kind: StoryObject` entities plus traits based on interactions.
- `NPC` JSON objects -> `kind: NPC` entities.
- `Ship` JSON objects -> `kind: Ship` entities.
- `name`, `description`, `examine_description`, `display_names`, `interior_descriptions`, and `taglines` -> `Presentable` fields/rules.
- Nested `destinations` -> initial `Contains(parent, child)` or `At(child, parent)` assertions.
- Authored object/ship placement -> initial `At(entity, destination)` assertions.
- `hops` -> initial `Hop(system, other_system)` assertions.
- Orbital parent -> `MoonOf(moon, parent)` assertion.
- `start_location` -> `story.start` plus initial `At(player, destination)` and ship/docking assertions as needed.
- `before` entries -> `before` rules matching the corresponding action.
- `use_rules` -> `after` or `instead` rules matching `Use(actor, source, target)`.
- `sequences` -> rules or rulebooks that emit messages and set completion facts when their guard becomes true.
- String facts -> structured facts where possible. Keep legacy string fact support during transition.

The converter should preserve current JSON as the source of truth until the YAML runtime passes parity tests.

### A5. Validate YAML Against Current Behavior

After conversion:

- Load JSON and YAML versions side by side.
- Compare entity counts by kind.
- Compare destination tree traversal output.
- Compare menu choice labels for each reachable destination.
- Compare `--dump` output or a normalized narrative-surface dump.
- Compare known scripted interactions: Take, Use portrait on console, blocked entry, sequence completion, ship boarding, takeoff, and landing.

Checkpoint:

- The converted YAML produces the same current behavior through a compatibility adapter, even if the curses UI is still backed by old Python dataclasses.

## Track B: Parser And Curses Engine Migration

### B1. Extract A Core Runtime Module

Create a new module, for example `curses/qualms_core.py` or a package `qualms/`.

Initial classes:

- `GameDefinition`.
- `WorldState`.
- `Entity`.
- `TraitDefinition`.
- `TraitInstance`.
- `RelationDefinition`.
- `ActionDefinition`.
- `Rule`.
- `Effect`.
- `Predicate`.
- `ActionAttempt`.
- `ActionResult`.

Do not move curses rendering into this module. It should be pure enough to test without curses.

Tests to add immediately:

- Relation `At` can be tested and asserted.
- Pure relation without setter cannot be asserted.
- `Move` default behavior asserts `At`.
- `before` rule with `stop` blocks default behavior.
- `instead` rule with `stop` replaces default behavior.
- `after` rule runs after default behavior.
- Rule ordering is priority, then document order.
- Effects do not recursively trigger action rules.
- Failed effects roll back the action transaction.

### B2. Add YAML Loader And Validator

Add a YAML dependency only after deciding the packaging path. Reasonable Python choices:

- `PyYAML` for a simple parser.
- `ruamel.yaml` if preserving comments/order for editor round-tripping becomes important sooner.

Recommended first step:

- Implement a plain-data validator matching `specs/story-yaml-schema.md`.
- Avoid mixing validation with runtime object construction.
- Keep validation errors path-specific, like the current loader does.

Tests:

- Minimal core prelude loads.
- Minimal story with player, location, and `At` assertion loads.
- Unknown trait/action/relation ids fail.
- Bad field types fail.
- Bad rule pattern variables fail.
- Assertion of non-writable relation fails.
- Kind expansion produces the expected trait set.
- Rulebook expansion conjoins guards.

### B3. Build A Legacy JSON Adapter

Before switching authoring format, compile current JSON into the new runtime model in memory.

Why:

- It lets the rules engine be tested against current stories before the YAML conversion is complete.
- It keeps the curses UI playable during runtime migration.

Adapter behavior:

- `load_world(path)` can continue returning the old `StoryWorld` for curses.
- Add a parallel `load_legacy_game_definition(path)` returning `GameDefinition` and `WorldState`.
- Reuse current validation where possible.
- Keep current fact strings available as legacy facts.

Checkpoint:

- The new runtime can represent the current story graph and pass core behavior tests, even though curses has not yet switched to it.

### B4. Route Interactions Through Action Attempts

Replace direct state mutations one workflow at a time.

Order:

1. `Examine` and `Talk`: low-risk emitted text only.
2. `Take`: inventory/object location mutation.
3. `Use`: source/target action with current `use_rules`.
4. `Equip`: equipment relation/fact behavior.
5. Destination `Enter`: movement plus visited facts and sequences.
6. Ship `Board`, `TakeOff`, `Land`.
7. System `Jump`.

For each workflow:

- Keep the menu UI stable.
- Convert the selected menu item into an `ActionAttempt`.
- Let the core runtime apply rules/default effects.
- Render emitted events through the existing continue-message or sequence UI.
- Remove the old direct mutation only after parity tests pass.

Tests after each workflow:

- Existing baseline tests still pass.
- New action-level tests cover the migrated behavior.
- `./run.sh --validate` still passes.
- Manual smoke test for the curses path.

### B5. Replace Ad Hoc State With Relations/Facts

Current ad hoc state fields should become runtime state:

- `state.facts` -> `WorldState.memory`.
- `state.inventory` and `state.object_locations` -> `At`, `CarriedBy`, or `Contains` relations.
- `state.equipment` -> `Equipped(actor, item)` relation.
- `state.ship_locations` -> `At`, `DockedAt`, or `InOrbit` relations.
- `state.boarded_ship_id` -> `Aboard(actor, ship)` relation.
- `state.player_ship_id` -> `ControlledBy(ship, player)` relation.

Keep view state in curses:

- Current screen/view.
- Selection index.
- Map return view.
- Inventory return view.
- Editor box position.
- Pending input prompts.

The boundary should become: curses owns presentation/navigation state; the rules engine owns world state.

### B6. Switch The Source Of Truth To YAML

Only after runtime parity:

- Make `stories/stellar/story.qualms.yaml` the maintained source.
- Keep `story_systems.json` as a generated compatibility artifact for one transition period if useful.
- Update `run.sh` and `run-dev.sh` to prefer YAML when present.
- Update editor save paths to write YAML or, if round-tripping is not ready, temporarily disable destructive YAML editing.

Checkpoint:

- Fresh load from YAML has the same behavior as legacy JSON.
- Editing a simple destination/object/NPC in dev mode persists and reloads correctly.
- Legacy JSON examples still validate through the adapter or are migrated.

## Editor Migration

The editor should first target safe authoring operations:

- Edit `Presentable.name` and `Presentable.description`.
- Add a `Destination` entity and assert `At(child, parent)` or `Contains(parent, child)`.
- Add a `StoryObject` with `Presentable` and selected action traits.
- Add an `NPC` with `Presentable`, `Actor`, and social rules.
- Delete only entities that have no children or rewrite their incoming assertions safely.

Later editor work:

- Rule editing.
- Prelude-aware trait selection.
- Schema validation feedback while typing.
- AI co-authoring hooks that produce proposed entities/rules/assertions instead of raw state mutation.

## Risk Controls

- Do not migrate data format and action runtime in the same PR/change.
- Keep old JSON loader tests until YAML parity is proven.
- Treat current `--dump` as a golden narrative-surface validator.
- Add focused tests before removing each old direct state mutation.
- Prefer adapters over rewrites while behavior is still moving.
- Keep relation setters small and explicit; avoid hidden bidirectional state.
- Avoid storing both sides of a relation as canonical state.

## Suggested Milestones

1. Baseline tests for current JSON behavior.
2. Core runtime module with `At`, `Move`, rules, and effects.
3. Core and nova-like preludes drafted in YAML.
4. YAML validator and loader for minimal documents.
5. Legacy JSON -> runtime adapter.
6. JSON -> YAML converter.
7. Curses `Examine`, `Take`, and `Use` routed through action attempts.
8. Destination movement, sequences, and ship actions routed through action attempts.
9. YAML becomes source of truth.
10. Editor writes schema-compliant YAML safely.

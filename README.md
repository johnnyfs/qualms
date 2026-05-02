# Qualms

Qualms is a prototype for a rules-driven story engine and a nova-like game built on top of it. The long-term goal is to define a compact declarative model for game rules that can be projected into different genres, interfaces, and implementations while preserving the same core behavior.

The current playable game is still Dark Qualms: a story-first bounty-hunter prototype with a maintained curses interface. The maintained story source is now `story.qualms.yaml`; the curses UI loads and edits that YAML file directly. The YAML schema uses genre-agnostic primitives: entities, traits, relations, actions, rules, and effects/assertions. Genre-specific concepts such as systems, orbitals, ships, people, inventory, and travel are expressed by authored preludes and story content rather than hard-coded as engine categories.

## Specs

Technical direction now lives in `specs/`:

- `specs/rules-engine.md`: runtime model, UML-style class/interface sketch, and action resolution sequence.
- `specs/story-yaml-schema.md`: rigorous YAML schema specification for engine definitions, prelude definitions, and story content.
- `specs/migration-plan.md`: plan for migrating current story data and the curses parser/engine toward the new model.

`story_declarative.txt` is an older design sketch. It is useful context, but it currently mixes engine primitives, nova-specific content, and implementation notes more than the new specs should.

## Layout

- `specs/`: technical design documents for the rules engine and future YAML schema.
- `stories/`: active story data. The current story is `stories/stellar/story.qualms.yaml`.
- `curses/`: maintained text interface for playing and editing the story graph.
- `godot/`: paused 2D orbital-flight prototype; kept for possible future interface work.
- `examples/`: valid older story datasets kept for reference.

The current story model defines systems, star types, graph hops, orbitals (`Planet`, `Moon`, `Station`), recursive local destinations, objects that support interactions such as examine, take, or use, NPCs that support examine and talk, destination sequences, and simple fact-gated before rules.

## Run

From the project root:

```sh
./run.sh
```

Run with the in-game editor exposed:

```sh
./run-dev.sh
```

Both scripts use the curses interface. By default they load:

```sh
stories/stellar/story.qualms.yaml
```

Run against another story directory:

```sh
./run.sh ./stories/stellar
```

The game reads and writes `story.qualms.yaml` inside that directory. You can still pass a direct legacy JSON file path for old examples and conversion checks:

```sh
./run.sh ./examples/blank/story_systems.json
```

If the YAML data path is missing or empty, the game creates a blank YAML world with one empty system so you can start authoring in-game.

Stories can optionally define `start_location` with a starting orbital and destination ID path. The current story starts docked at Mining Colony 5 on Blemish.

Validate story data without launching curses:

```sh
./run.sh --validate
./run.sh ./examples/sol-proof/story_systems.json --validate
```

Dump the defined narrative surface:

```sh
./run.sh --dump
```

## Controls

- Number: travel to a destination or choose a local destination
- `I`: open inventory
- `L`: leave system from the system screen; land from orbit or station approach
- `T`: take off from the docked destination or return to the system destination list from orbit
- `B`: back one level in a local destination graph
- `M`: show the local map
- `Q`: quit

## Editor Mode

`./run-dev.sh` enables an editor sub-box below the game view. These commands are hidden and disabled in normal play.

`A` means:

- System screen: add an orbital by type (`Planet`, `Moon`, `Station`) with a name and description.
- Leave-system screen: add a linked system by compass direction, name, and description.
- Destination screen: add a child destination under the current destination.
- Inside a destination, `A` opens a menu: add destination, add object, or add NPC.
- Inside a destination, `D` deletes a local detail: an object, NPC, or child destination.
- `R` reloads story data from disk while preserving the current location and in-memory state.

`D` also deletes orbitals from the system screen. Moons block deletion of their parent until the child orbital is deleted.

`E` means:

- System screen: edit the current system name and description.
- Orbiting/approaching screen: edit the current orbital name and description.
- Destination description screen: edit that destination name and description.

## Current Story Data

The YAML story imports `stories/prelude/nova-qualms.qualms.yaml`, which imports the core prelude. Story content is authored as entities, trait field values, initial relation assertions, facts, and local rules. The curses UI projects that declarative model into its menu views while using the rules runtime for action resolution.

The loader validates the YAML schema, compiles preludes and story content into the runtime definition, then validates nova-like constraints such as duplicate IDs, moon parents, reciprocal hops, hop distance, and at most 9 choices per menu.

Inventory opens with `I`. Inventory items can be examined with `X`; equippable items define an `equipment_slot` and can be equipped with `E`, replacing any item already in that slot. Rules can test equipment slots with facts like `equipped:slot:Exosuit`.

Systems define graph data through trait fields:

```yaml
- id: sol-proof
  kind: System
  fields:
    Presentable:
      name: Sol Proof
      description: Old money, crowded ports, and licensed violence.
    StarSystem:
      star_type: G-type main sequence
      x: 0
      y: 0
      hops: [barnard-gate, sirius-wake]
```

Hop links must be reciprocal, must point to known systems, and must stay under the current short-hop limit.

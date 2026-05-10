# Runtime Roadmap

This roadmap starts from the current source of truth: `story.qualms.yaml` files that import the core and nova-like preludes, compile through `qualms.yaml_loader`, and run through `qualms.core`.

## Current Baseline

- The default prompt CLI loads and saves `story.qualms.yaml` directly; the legacy curses UI remains available behind `--curses`.
- Story data is authored as entities, trait fields, initial assertions, stored relations, legacy facts, and rules.
- The prompt UI and curses UI project the compiled runtime definition into playable/editor data.
- Action resolution for scripted interactions goes through `RulesEngine`.
- The maintained story and examples validate through the YAML loader.

## Validation Priorities

- Keep schema validation path-specific and deterministic.
- Keep behavioral tests around navigation, visibility, inventory, equipment, scripted rules, ship control, boarding, takeoff, landing, reload, and editor save/reload flows.
- Add focused tests whenever a rule, relation, trait, or YAML construct moves closer to the runtime core.

## Runtime Priorities

- Move more curses-specific action helpers onto declarative actions and effects.
- Continue moving durable remembered state from legacy facts into stored relations.
- Tighten relation setters so authored effects can assert or retract relations instead of mutating trait fields directly.
- Keep effects non-recursive: applying an effect must not dispatch another action through the rules engine.
- Preserve deterministic rule ordering by phase, priority, and document order.
- Roll back failed action attempts atomically.
- Add a query layer once prompt/coauthoring usage clarifies what state needs to be asked for; avoid designing that API ahead of observed needs.

## Authoring Priorities

- Split reusable nova-like definitions into the prelude only when they are stable.
- Keep story-local metadata limited to editor projection needs such as local IDs, display labels, visibility gates, and compact interaction labels.
- Prefer explicit traits, relations, and rules in story files over hidden parser behavior.
- Add round-trip tests before expanding the editor’s write surface.

## Interface Priorities

- Keep the prompt CLI as the maintained playable interface.
- Keep the curses editor as a legacy/reference editor while migration continues.
- Continue treating UI dataclasses as a projection of the YAML runtime definition, not as an independent story model.
- Add editor affordances incrementally, with save/reload validation after each change.
- Defer richer interfaces until the runtime and schema contracts are stable enough to share across implementations.

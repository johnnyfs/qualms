# Core Qualms Prelude

Core defines the general interactive-fiction model.

Entities are object records. They can get behavior from a `kind`, direct `traits`, trait field overrides in `fields`, local rules, and metadata used by authoring/UI layers.

Important core traits:

- `Presentable`: display `name`, `description`, and optional `examine_description`.
- `Actor`: something that can act.
- `Location`: a place-like entity. It contributes the writable `Path(source, target)` relation for explicit exits between locations.
- `Relocatable`: something with a current `location`. It contributes writable `At(subject, location)`.
- `Container`: something that can contain or reveal contents.
- `Portable`, `Usable`, `Equipment`, and `Ownable`: common object affordances.

Important core actions include `Enter`, `Move`, `Examine`, `Take`, `Use`, and `Equip`. Rules can run before, instead of, or after actions. Rule effects can emit text, assert relations, set fields, and set/clear facts.

Story setup usually creates `At` assertions for initial containment and `Path` assertions for non-child exits. Parent/child containment and explicit paths are different: a child destination is structurally inside a location, while `Path` is a navigable route between peer or distant locations.

Authoring rule of thumb: keep `Presentable.description` stable. Do not describe transient state like a movable object, NPC, ship, or open/closed condition being present if that can change during play. Use assertions, facts, fields, and rules for mutable state.

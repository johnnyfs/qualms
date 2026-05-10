# Nova Prelude

Nova extends Core with a space-travel story vocabulary.

Main traits:

- `StarSystem`: system display and map data: star type, x/y position, and jump `hops`.
- `OrbitalBody`: planet, moon, or station metadata plus `default_landing_path`.
- `Vehicle`, `Boardable`, `Jumpable`, `Port`, `FuelStation`, `Social`, and `Identifiable`: ship, port, fuel, NPC, and discovery affordances.

Main kinds:

- `System`: a star system and top-level location.
- `Planet`, `Moon`, `Station`: orbital locations inside a system.
- `Destination`: a specific place on or inside an orbital body.
- `StoryObject`: examinable/takeable/usable object.
- `NPC`: social actor.
- `Ship`: movable location/vehicle.
- `Player`: actor and container/location for inventory.

Common assertions:

- `At(subject, location)` places orbitals, destinations, objects, NPCs, and sometimes ships.
- `DockedAt(ship, destination)` places a ship at a port-like destination.
- `ControlledBy(ship, actor)` marks a piloted ship.
- `Path(source, target)` creates an explicit exit between locations.

Nova stories normally start with one or more `System` entities, orbitals inside systems, destinations inside orbitals, and objects/NPCs inside destinations. Use `Path` when the player should be able to move between locations that are not simply child destinations.

Descriptions should avoid embedding current placements. For example, a docking location can mention clamps, berth markings, lights, and machinery, but should not say a specific ship is docked there unless that ship is immovable. The ship's presence belongs in `DockedAt` or `At` assertions.

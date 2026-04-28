# Dark Qualms

Dark Qualms is a story-first bounty-hunter game prototype. The project is now organized around an interface-independent story graph, with a maintained curses interface and a paused Godot prototype.

## Layout

- `stories/`: active story data. The current story is `stories/stellar/story_systems.json`.
- `curses/`: maintained text interface for playing and editing the story graph.
- `godot/`: unmaintained 2D orbital-flight prototype; kept for possible future interface work.
- `examples/`: valid older story datasets kept for reference.

The story model currently defines systems, star types, graph hops, orbitals (`Planet`, `Moon`, `Station`), recursive local destinations, and objects that support interactions such as examine, take, or use.

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
stories/stellar/story_systems.json
```

Run against another story directory:

```sh
./run.sh ./examples/sol-proof
```

The game reads and writes `story_systems.json` inside that directory. You can also pass a direct JSON file path:

```sh
./run.sh ./examples/blank/story_systems.json
```

If the data path is missing, empty, or contains `{}`, the game creates a blank world with one empty system so you can start authoring in-game.

Validate story data without launching curses:

```sh
./run.sh --validate
./run.sh ./examples/sol-proof --validate
```

Dump the defined narrative surface:

```sh
./run.sh --dump
```

## Controls

- Number: travel to a destination or choose a local destination
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
- Inside a destination, `A` opens a menu: add destination or add object.
- Inside a destination, `D` deletes a local detail: an object or child destination.

`D` also deletes orbitals from the system screen. Moons block deletion of their parent until the child orbital is deleted.

`E` means:

- System screen: edit the current system name and description.
- Orbiting/approaching screen: edit the current orbital name and description.
- Destination description screen: edit that destination name and description.

## Story Data

A destination is deliberately explicit:

```json
{
  "id": "earth",
  "name": "Earth",
  "type": "Planet",
  "description": "Old money, crowded ports, and licensed violence.",
  "landing_options": [
    {
      "kind": "Bar",
      "name": "Blue Anchor",
      "description": "Bounty clerks and dockhands keep separate corners.",
      "objects": [
        {
          "name": "Admire the decor",
          "description": "A specific thing to notice.",
          "interactions": ["Examine"]
        }
      ],
      "destinations": []
    }
  ]
}
```

The loader validates required fields, destination types, object interactions, duplicate IDs, moon parents, and at most 9 choices per menu. Landing destinations may contain nested `destinations`, forming a recursive graph, and `objects`. Objects are denormalized in the menu by interaction, so one poster with `["Examine", "Take"]` appears as two numbered choices.

Systems also define graph data:

```json
{
  "id": "sol-proof",
  "name": "Sol Proof",
  "star_type": "G-type main sequence",
  "position_au": [0, 0],
  "hops": ["barnard-gate", "sirius-wake"]
}
```

Hop links must be reciprocal, must point to known systems, and must stay under the current short-hop limit.

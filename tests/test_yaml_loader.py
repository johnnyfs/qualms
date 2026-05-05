from __future__ import annotations

import tempfile
import textwrap
import unittest
from pathlib import Path

from qualms import ActionAttempt, RulesEngine, SchemaError, load_game_definition


ROOT = Path(__file__).resolve().parents[1]
CORE_PRELUDE = ROOT / "stories" / "prelude" / "core.qualms.yaml"
NOVA_PRELUDE = ROOT / "stories" / "prelude" / "nova-qualms.qualms.yaml"
TMPDIRS: list[tempfile.TemporaryDirectory[str]] = []


def write_yaml(text: str) -> Path:
    tmpdir = tempfile.TemporaryDirectory()
    TMPDIRS.append(tmpdir)
    path = Path(tmpdir.name) / "story.qualms.yaml"
    path.write_text(textwrap.dedent(text).strip() + "\n", encoding="utf-8")
    return path


class YamlLoaderTests(unittest.TestCase):
    def test_preludes_load(self) -> None:
        core = load_game_definition(CORE_PRELUDE)
        nova = load_game_definition(NOVA_PRELUDE)

        self.assertIn("Relocatable", core.traits)
        self.assertIn("At", core.relations)
        self.assertIn("Move", core.actions)
        self.assertIn("Ship", nova.kinds)
        self.assertIn("DockedAt", nova.relations)
        self.assertIn("FuelStation", nova.traits)
        self.assertIn("Refuel", nova.actions)

    def test_vehicle_jump_fuel_blocks_jumps_and_refuels(self) -> None:
        path = write_yaml(
            f"""
            qualms: "0.1"
            id: fuel-story
            imports:
              - "{NOVA_PRELUDE}"
            story:
              entities:
                - id: player
                  kind: Player
                - id: a
                  kind: System
                - id: b
                  kind: System
                - id: ship
                  kind: Ship
                - id: station
                  kind: StoryObject
                  traits:
                    - id: FuelStation
              assertions:
                - relation: At
                  args:
                    - {{ ref: ship }}
                    - {{ ref: a }}
            """
        )
        definition = load_game_definition(path)
        state = definition.instantiate()
        engine = RulesEngine(definition)

        blocked = engine.attempt(
            state,
            ActionAttempt("Jump", {"actor": "player", "ship": "ship", "destination_system": "b"}),
        )
        self.assertEqual(blocked.status, "blocked")
        self.assertEqual(blocked.events[0]["text"], "The ship needs jump fuel.")
        self.assertTrue(state.test("At", ["ship", "a"]))

        state.set_field("ship", "Vehicle", "jump_fuel", 2)
        jumped = engine.attempt(
            state,
            ActionAttempt("Jump", {"actor": "player", "ship": "ship", "destination_system": "b"}),
        )
        self.assertEqual(jumped.status, "succeeded")
        self.assertTrue(state.test("At", ["ship", "b"]))
        self.assertEqual(state.get_field("ship", "Vehicle", "jump_fuel"), 1)

        inactive = engine.attempt(
            state,
            ActionAttempt("Refuel", {"actor": "player", "ship": "ship", "station": "station"}),
        )
        self.assertEqual(inactive.status, "blocked")
        self.assertEqual(inactive.events[0]["text"], "The fueling station is powered down.")

        state.assert_relation("FuelStationActive", ["station"])
        refueled = engine.attempt(
            state,
            ActionAttempt("Refuel", {"actor": "player", "ship": "ship", "station": "station"}),
        )
        self.assertEqual(refueled.status, "succeeded")
        self.assertEqual(state.get_field("ship", "Vehicle", "jump_fuel"), 3)

    def test_minimal_story_instantiates_and_asserts_at(self) -> None:
        path = write_yaml(
            f"""
            qualms: "0.1"
            id: minimal-story
            imports:
              - "{CORE_PRELUDE}"
            story:
              entities:
                - id: player
                  kind: Person
                - id: room
                  kind: Place
                  fields:
                    Presentable:
                      name: "Room"
                - id: box
                  traits:
                    - id: Relocatable
              assertions:
                - relation: At
                  args:
                    - {{ ref: box }}
                    - {{ ref: room }}
            """
        )

        definition = load_game_definition(path)
        state = definition.instantiate()

        self.assertTrue(state.test("At", ["box", "room"]))
        self.assertTrue(state.has_trait("room", "Container"))
        self.assertEqual(state.get_field("room", "Presentable", "name"), "Room")

    def test_stored_remembered_relation_instantiates_from_initial_assertion(self) -> None:
        path = write_yaml(
            f"""
            qualms: "0.1"
            id: remembered-story
            imports:
              - "{CORE_PRELUDE}"
            definitions:
              relations:
                - id: Visited
                  persistence: remembered
                  params:
                    - id: actor
                      type: ref<Actor>
                    - id: location
                      type: ref<Location>
            story:
              entities:
                - id: player
                  kind: Person
                - id: room
                  kind: Place
              assertions:
                - relation: Visited
                  args:
                    - {{ ref: player }}
                    - {{ ref: room }}
            """
        )

        definition = load_game_definition(path)
        state = definition.instantiate()

        self.assertTrue(state.test("Visited", ["player", "room"]))
        self.assertIn(("Visited", ("player", "room")), state.remembered_relations)

    def test_unknown_trait_fails_validation(self) -> None:
        path = write_yaml(
            """
            qualms: "0.1"
            id: bad-story
            story:
              entities:
                - id: thing
                  traits:
                    - id: MissingTrait
            """
        )

        with self.assertRaisesRegex(SchemaError, "unknown trait"):
            load_game_definition(path)

    def test_initial_assertion_requires_writable_relation(self) -> None:
        path = write_yaml(
            f"""
            qualms: "0.1"
            id: bad-assertion
            imports:
              - "{CORE_PRELUDE}"
            story:
              entities:
                - id: room
                  kind: Place
                  fields:
                    Presentable:
                      name: "Room"
              assertions:
                - relation: Named
                  args:
                    - {{ ref: room }}
                    - "Room"
            """
        )

        with self.assertRaisesRegex(SchemaError, "non-writable relation Named"):
            load_game_definition(path)

    def test_rulebook_guard_compiles_into_contained_rules(self) -> None:
        path = write_yaml(
            f"""
            qualms: "0.1"
            id: guarded-story
            imports:
              - "{CORE_PRELUDE}"
            definitions:
              rulebooks:
                - id: guarded
                  when:
                    fact:
                      id: Ready
                  rules:
                    - id: block_move
                      phase: before
                      match:
                        action: Move
                        args:
                          subject: {{ ref: box }}
                      effects:
                        - emit:
                            text: "No."
                      control: stop
            story:
              entities:
                - id: player
                  kind: Person
                - id: room-a
                  kind: Place
                - id: room-b
                  kind: Place
                - id: box
                  traits:
                    - id: Relocatable
              assertions:
                - relation: At
                  args:
                    - {{ ref: box }}
                    - {{ ref: room-a }}
            """
        )
        definition = load_game_definition(path)
        state = definition.instantiate()
        engine = RulesEngine(definition)

        first = engine.attempt(
            state,
            ActionAttempt("Move", {"actor": "player", "subject": "box", "destination": "room-b"}),
        )
        self.assertEqual(first.status, "succeeded")
        self.assertTrue(state.test("At", ["box", "room-b"]))

        state.assert_relation("At", ["box", "room-a"])
        state.memory.set("Ready")
        second = engine.attempt(
            state,
            ActionAttempt("Move", {"actor": "player", "subject": "box", "destination": "room-b"}),
        )
        self.assertEqual(second.status, "blocked")
        self.assertEqual(second.events[0]["text"], "No.")
        self.assertTrue(state.test("At", ["box", "room-a"]))

    def test_rule_pattern_unknown_action_arg_fails_validation(self) -> None:
        path = write_yaml(
            f"""
            qualms: "0.1"
            id: bad-rule
            imports:
              - "{CORE_PRELUDE}"
            definitions:
              rulebooks:
                - id: bad
                  rules:
                    - id: bad_arg
                      phase: before
                      match:
                        action: Move
                        args:
                          bogus: {{ bind: x }}
                      effects: []
            """
        )

        with self.assertRaisesRegex(SchemaError, "unknown action arg bogus"):
            load_game_definition(path)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

from qualms import ActionAttempt, RulesEngine, load_game_definition
from qualms.story_writer import story_world_to_yaml_data, write_story_world_yaml


ROOT = Path(__file__).resolve().parents[1]
STELLAR_YAML = ROOT / "stories" / "stellar" / "story.qualms.yaml"
BLANK_YAML = ROOT / "examples" / "blank" / "story.qualms.yaml"
SOL_PROOF_YAML = ROOT / "examples" / "sol-proof" / "story.qualms.yaml"


def load_story_module():
    module_path = ROOT / "curses" / "dark_qualms_story.py"
    spec = importlib.util.spec_from_file_location("dark_qualms_story", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load dark_qualms_story.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


dq = load_story_module()


def count_local_entities(world) -> int:
    total = 1  # player
    for system in world.systems:
        total += 1
        for orbital in system.orbitals:
            total += 1
            total += count_destinations(orbital.landing_options)
    return total


def count_destinations(destinations) -> int:
    total = 0
    for destination in destinations:
        total += 1
        total += len(destination.objects)
        total += len(destination.npcs)
        total += len(destination.ships)
        for ship in destination.ships:
            total += len(ship.objects)
        total += count_destinations(destination.destinations)
    return total


class StoryYamlProjectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.world = dq.load_world(STELLAR_YAML)

    def test_story_yaml_loads_as_runtime_definition(self) -> None:
        definition = load_game_definition(STELLAR_YAML)
        state = definition.instantiate()
        id_map = definition.metadata["local_id_map"]

        self.assertEqual(len(definition.initial_entities), count_local_entities(self.world))
        self.assertTrue(state.test("At", [id_map["portrait-of-enrick"], id_map["pointless-bar"]]))
        self.assertTrue(state.test("DockedAt", [id_map["canary"], id_map["impact-crater"]]))

    def test_story_yaml_writer_output_loads(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "story.qualms.yaml"
            write_story_world_yaml(self.world, output)

            definition = load_game_definition(output)

        self.assertEqual(len(definition.initial_entities), count_local_entities(self.world))
        self.assertIn("local_id_map", definition.metadata)
        self.assertIn("control-console", definition.metadata["local_id_map"])

    def test_checked_in_story_loads(self) -> None:
        definition = load_game_definition(STELLAR_YAML)
        state = definition.instantiate()

        self.assertEqual(len(definition.initial_entities), count_local_entities(self.world))
        self.assertIn("player", state.entities)

    def test_checked_in_examples_load(self) -> None:
        for path in (BLANK_YAML, SOL_PROOF_YAML):
            with self.subTest(path=path):
                definition = load_game_definition(path)
                state = definition.instantiate()
                self.assertIn("player", state.entities)

    def test_use_rule_controls_canary(self) -> None:
        definition = load_game_definition(STELLAR_YAML)
        state = definition.instantiate()
        engine = RulesEngine(definition)
        id_map = definition.metadata["local_id_map"]
        state.assert_relation("CarriedBy", ["player", id_map["portrait-of-enrick"]])

        result = engine.attempt(
            state,
            ActionAttempt(
                "Use",
                {
                    "actor": "player",
                    "source": id_map["portrait-of-enrick"],
                    "target": id_map["control-console"],
                },
            ),
        )

        self.assertEqual(result.status, "succeeded")
        self.assertEqual([event["text"] for event in result.events], ["The iris whirs with approval, and the console powers up."])
        self.assertTrue(state.test("ControlledBy", [id_map["canary"], "player"]))
        self.assertTrue(state.memory.has("ship:canary:control"))

    def test_story_writer_preserves_fuel_station_activation(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "story.qualms.yaml"
            write_story_world_yaml(self.world, output)
            definition = load_game_definition(output)
        state = definition.instantiate()
        engine = RulesEngine(definition)
        id_map = definition.metadata["local_id_map"]
        state.assert_relation("At", ["player", id_map["command-center"]])

        result = engine.attempt(
            state,
            ActionAttempt(
                "PowerUp",
                {
                    "actor": "player",
                    "target": id_map["fuel-station-controls"],
                },
            ),
        )

        self.assertEqual(result.status, "blocked")
        self.assertEqual(result.events[0]["text"], "The old fueling station hums awake below.")
        self.assertTrue(state.test("FuelStationActive", [id_map["fueling-station"]]))
        self.assertTrue(state.memory.has("fuel-station:fueling-station:active"))

    def test_before_rule_blocks_lunar_surface(self) -> None:
        definition = load_game_definition(STELLAR_YAML)
        state = definition.instantiate()
        engine = RulesEngine(definition)
        id_map = definition.metadata["local_id_map"]

        result = engine.attempt(
            state,
            ActionAttempt(
                "Enter",
                {
                    "actor": "player",
                    "destination": id_map["lunar-surface"],
                },
            ),
        )

        self.assertEqual(result.status, "blocked")
        self.assertIn("cold-boiling", result.events[0]["text"])
        self.assertFalse(state.test("At", ["player", id_map["lunar-surface"]]))

    def test_story_writer_produces_schema_sections(self) -> None:
        data = story_world_to_yaml_data(self.world)

        self.assertEqual(data["qualms"], "0.1")
        self.assertEqual(data["id"], "stellar")
        self.assertTrue(data["imports"])
        self.assertTrue(data["story"]["entities"])
        self.assertTrue(data["story"]["assertions"])

    def test_story_writer_uses_remembered_relations_for_sequences(self) -> None:
        data = story_world_to_yaml_data(self.world)
        mining_colony = next(
            entity
            for entity in data["story"]["entities"]
            if entity["metadata"].get("local_id") == "mining-colony-5"
        )
        rule_ids = [rule["id"] for rule in mining_colony["rules"]]
        sequence_rule = next(rule for rule in mining_colony["rules"] if rule["id"] == "sequence:blemish-crash")

        self.assertNotIn("visited:mining-colony-5", rule_ids)
        self.assertEqual(
            sequence_rule["when"],
            {
                "all": [
                    {
                        "relation": {
                            "id": "Visited",
                            "args": [
                                {"ref": "player"},
                                {"ref": "empty-system:rainbow:mining-colony-5:pointless-bar"},
                            ],
                        }
                    },
                    {
                        "relation": {
                            "id": "Visited",
                            "args": [
                                {"ref": "player"},
                                {"ref": "empty-system:rainbow:mining-colony-5:pointless-settlement"},
                            ],
                        }
                    },
                    {
                        "not": {
                            "relation": {
                                "id": "SequenceComplete",
                                "args": [{"literal": "blemish-crash"}],
                            }
                        }
                    },
                ]
            },
        )
        self.assertEqual(
            sequence_rule["effects"][-1],
            {
                "assert": {
                    "relation": "SequenceComplete",
                    "args": [{"literal": "blemish-crash"}],
                }
            },
        )


if __name__ == "__main__":
    unittest.main()

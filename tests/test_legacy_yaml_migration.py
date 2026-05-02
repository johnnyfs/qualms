from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

from qualms import ActionAttempt, RulesEngine, load_game_definition
from qualms.legacy import legacy_world_to_game_definition, legacy_world_to_yaml_data, write_legacy_world_yaml


ROOT = Path(__file__).resolve().parents[1]
STELLAR_YAML = ROOT / "stories" / "stellar" / "story.qualms.yaml"


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


def count_legacy_entities(world) -> int:
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


class LegacyYamlMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.world = dq.load_world(STELLAR_YAML)

    def test_legacy_world_compiles_to_runtime_definition(self) -> None:
        definition = legacy_world_to_game_definition(self.world)
        state = definition.instantiate()
        id_map = definition.metadata["legacy_id_map"]

        self.assertEqual(len(definition.initial_entities), count_legacy_entities(self.world))
        self.assertTrue(state.test("At", [id_map["portrait-of-enrick"], id_map["pointless-bar"]]))
        self.assertTrue(state.test("DockedAt", [id_map["canary"], id_map["impact-crater"]]))

    def test_legacy_yaml_converter_output_loads(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output = Path(tmpdir) / "story.qualms.yaml"
            write_legacy_world_yaml(self.world, output)

            definition = load_game_definition(output)

        self.assertEqual(len(definition.initial_entities), count_legacy_entities(self.world))
        self.assertIn("legacy_id_map", definition.metadata)
        self.assertIn("control-console", definition.metadata["legacy_id_map"])

    def test_checked_in_converted_story_loads(self) -> None:
        definition = load_game_definition(STELLAR_YAML)
        state = definition.instantiate()

        self.assertEqual(len(definition.initial_entities), count_legacy_entities(self.world))
        self.assertIn("player", state.entities)

    def test_converted_use_rule_controls_canary(self) -> None:
        definition = legacy_world_to_game_definition(self.world)
        state = definition.instantiate()
        engine = RulesEngine(definition)
        id_map = definition.metadata["legacy_id_map"]

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

    def test_converted_before_rule_blocks_lunar_surface(self) -> None:
        definition = legacy_world_to_game_definition(self.world)
        state = definition.instantiate()
        engine = RulesEngine(definition)
        id_map = definition.metadata["legacy_id_map"]

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

    def test_converter_produces_schema_sections(self) -> None:
        data = legacy_world_to_yaml_data(self.world)

        self.assertEqual(data["qualms"], "0.1")
        self.assertEqual(data["id"], "stellar")
        self.assertTrue(data["imports"])
        self.assertTrue(data["story"]["entities"])
        self.assertTrue(data["story"]["assertions"])


if __name__ == "__main__":
    unittest.main()

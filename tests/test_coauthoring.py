from __future__ import annotations

import unittest
import tempfile
import importlib.util
import sys
from pathlib import Path

from pydantic import ValidationError

from qualms import load_game_definition
from qualms.coauthoring import CoauthorWorkspace
from qualms.coauthoring.models import (
    DeleteEntity,
    DestinationCreate,
    EntityUpdate,
    PathCreate,
    PresentablePatch,
    ShipCreate,
    StoryObjectCreate,
)


ROOT = Path(__file__).resolve().parents[1]
WAVE = ROOT / "stories" / "wave_collapse" / "story.qualms.yaml"


def load_story_module():
    module_path = ROOT / "curses" / "dark_qualms_story.py"
    spec = importlib.util.spec_from_file_location("dark_qualms_story", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class CoauthorWorkspaceTests(unittest.TestCase):
    def test_wave_collapse_story_loads(self) -> None:
        definition = load_game_definition(WAVE)
        state = definition.instantiate()

        self.assertIn("wave-collapse:needle:observation-deck", state.entities)

    def test_wave_collapse_story_loads_in_adventure_cli(self) -> None:
        dq = load_story_module()
        world = dq.load_world(WAVE)

        self.assertEqual(world.start_system, "wave-collapse")

    def test_wave_collapse_fuel_cradle_refuels_cli_ship(self) -> None:
        dq = load_story_module()
        world = dq.load_world(WAVE)
        state = dq.initial_game_state(world, editor_enabled=False)

        world, state, should_quit = dq.handle_cli_command(None, world, WAVE, False, state, "go Docking Spur")
        self.assertFalse(should_quit)
        world, state, should_quit = dq.handle_cli_command(None, world, WAVE, False, state, "board Skiff Sparrow")
        self.assertFalse(should_quit)
        world, state, should_quit = dq.handle_cli_command(None, world, WAVE, False, state, "refuel")

        self.assertFalse(should_quit)
        self.assertEqual(state.ship_fuel["sparrow"], 3)

    def test_workspace_tools_edit_running_model_without_saving(self) -> None:
        workspace = CoauthorWorkspace(WAVE)

        destination = workspace.create_destination(
            DestinationCreate(
                parent_id="wave-collapse:needle:observation-deck",
                id="analysis-nook",
                name="Analysis Nook",
                description="A recessed console bay filled with frozen waveform captures.",
            )
        )
        story_object = workspace.create_object(
            StoryObjectCreate(
                location_id="wave-collapse:needle:observation-deck:analysis-nook",
                id="waveform-slate",
                name="Waveform slate",
                description="A thin slate looping the same impossible measurement.",
                collectable=True,
            )
        )
        path = workspace.connect_path(
            PathCreate(
                source_id="wave-collapse:needle:observation-deck",
                target_id="wave-collapse:needle:observation-deck:analysis-nook",
                bidirectional=True,
            )
        )
        validation = workspace.validate()

        self.assertTrue(destination.ok)
        self.assertTrue(story_object.ok)
        self.assertTrue(path.ok)
        self.assertTrue(validation.ok, validation.message)
        self.assertIn("analysis-nook", workspace.raw["metadata"]["local_id_map"])

    def test_port_display_kind_is_legacy_reload_safe(self) -> None:
        workspace = CoauthorWorkspace(WAVE)

        result = workspace.create_destination(
            DestinationCreate(
                parent_id="wave-collapse:needle",
                id="service-port",
                name="Service Port",
                description="A maintenance berth with cold docking clamps.",
                display_kind="Port",
            )
        )
        entity = result.data

        self.assertTrue(result.ok)
        self.assertEqual(entity["metadata"]["display_kind"], "Destination")
        self.assertTrue(entity["metadata"]["port"])
        self.assertIn({"id": "Port"}, entity["traits"])
        self.assertTrue(workspace.validate().ok)

    def test_create_ship_adds_ship_specific_shape(self) -> None:
        workspace = CoauthorWorkspace(WAVE)

        result = workspace.create_ship(
            ShipCreate(
                id="test-skiff",
                name="Test Skiff",
                description="A compact test vessel.",
                docked_at_id="wave-collapse:needle:observation-deck",
                controlled_by_actor_id="player",
            )
        )

        self.assertTrue(result.ok)
        entity = workspace.top_entity_by_id()["test-skiff"]
        self.assertEqual(entity["kind"], "Ship")
        self.assertIn("Vehicle", entity["fields"])
        self.assertTrue(workspace._has_assertion("DockedAt", ["test-skiff", "wave-collapse:needle:observation-deck"]))
        self.assertTrue(workspace._has_assertion("ControlledBy", ["test-skiff", "player"]))
        self.assertTrue(workspace.validate().ok)

    def test_create_object_rejects_non_legacy_interaction(self) -> None:
        with self.assertRaises(ValidationError):
            StoryObjectCreate(
                location_id="wave-collapse:needle:docking-spur",
                id="bad-fuel",
                name="Bad Fuel",
                description="A bad test fixture.",
                interactions=["Refuel"],
            )

    def test_validate_rejects_legacy_unsafe_object_interaction_metadata(self) -> None:
        workspace = CoauthorWorkspace(WAVE)
        result = workspace.create_object(
            StoryObjectCreate(
                location_id="wave-collapse:needle:docking-spur",
                id="test-cradle",
                name="Test Cradle",
                description="A test refueling fixture.",
                interactions=["Use"],
            )
        )
        self.assertTrue(result.ok)
        workspace.top_entity_by_id()[result.data["id"]]["metadata"]["interactions"] = ["Refuel"]

        validation = workspace.validate()

        self.assertFalse(validation.ok)
        self.assertIn("must be one of", validation.message)

    def test_update_entity_uses_explicit_patch_schema(self) -> None:
        workspace = CoauthorWorkspace(WAVE)

        result = workspace.update_entity(
            EntityUpdate(
                id="wave-collapse:needle:observation-deck",
                presentable=PresentablePatch(name="Main Observation Deck"),
            )
        )

        self.assertTrue(result.ok)
        self.assertEqual(
            workspace.top_entity_by_id()["wave-collapse:needle:observation-deck"]["fields"]["Presentable"]["name"],
            "Main Observation Deck",
        )

    def test_delete_refuses_referenced_entity_without_cascade(self) -> None:
        workspace = CoauthorWorkspace(WAVE)

        result = workspace.delete_entity(DeleteEntity(id="wave-collapse:needle:observation-deck"))

        self.assertFalse(result.ok)
        self.assertIn("references remain", result.message)


if __name__ == "__main__":
    unittest.main()

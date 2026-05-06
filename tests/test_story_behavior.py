from __future__ import annotations

import copy
import importlib.util
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
STELLAR = ROOT / "stories" / "stellar" / "story.qualms.yaml"
BLANK = ROOT / "examples" / "blank" / "story.qualms.yaml"
SOL_PROOF = ROOT / "examples" / "sol-proof" / "story.qualms.yaml"


class TtyStringIO(io.StringIO):
    def isatty(self) -> bool:
        return True


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


def story_raw(path: Path = STELLAR) -> dict:
    return dq.world_to_raw(dq.load_world(path))


def load_raw(raw: dict):
    return dq.load_world_from_raw(raw)


def destination_by_ids(world, *destination_ids: str):
    orbital = dq.orbital_by_id(world.system_by_id(world.start_system), world.start_orbital_id)
    path = dq.destination_path_by_ids(orbital, tuple(destination_ids))
    destination = dq.destination_at_path(orbital, list(path))
    if destination is None:
        raise AssertionError(f"destination not found: {destination_ids}")
    return destination


def destination_by_ids_for_orbital(world, system_id: str, orbital_id: str, *destination_ids: str):
    orbital = dq.orbital_by_id(world.system_by_id(system_id), orbital_id)
    path = dq.destination_path_by_ids(orbital, tuple(destination_ids))
    destination = dq.destination_at_path(orbital, list(path))
    if destination is None:
        raise AssertionError(f"destination not found: {destination_ids}")
    return destination


class StoryLoaderTests(unittest.TestCase):
    def test_story_directory_prefers_yaml_when_present(self) -> None:
        self.assertEqual(dq.resolve_data_file(ROOT / "stories" / "stellar"), ROOT / "stories" / "stellar" / "story.qualms.yaml")

    def test_current_stories_load_and_dump(self) -> None:
        for path in (ROOT / "stories" / "stellar", STELLAR, BLANK, SOL_PROOF):
            with self.subTest(path=path):
                world = dq.load_world(path)
                self.assertTrue(world.systems)
                self.assertIn(world.system_by_id(world.start_system), world.systems)
                self.assertTrue(dq.dump_world(world))

    def test_missing_story_directory_creates_blank_yaml_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            story_dir = Path(tmpdir) / "new-story"
            world = dq.load_world(story_dir)

            self.assertEqual(world.start_system, "empty-system")
            self.assertTrue((story_dir / "story.qualms.yaml").exists())

    def test_initial_location_matches_current_story_start(self) -> None:
        world = dq.load_world(STELLAR)
        state = dq.initial_game_state(world, editor_enabled=False)

        self.assertEqual(state.system_id, "empty-system")
        self.assertEqual(state.orbital_id, "rainbow")
        self.assertEqual(world.start_destination_ids, ("mining-colony-5",))

        orbital = dq.orbital_by_id(world.system_by_id(state.system_id), state.orbital_id)
        self.assertEqual(tuple(dq.current_destination_ids(world, state.destination_path, state.system_id, state.orbital_id)), world.start_destination_ids)
        self.assertEqual(dq.destination_at_path(orbital, state.destination_path).id, "mining-colony-5")

    def test_loader_rejects_duplicate_system_ids(self) -> None:
        raw = story_raw()
        raw["systems"].append(copy.deepcopy(raw["systems"][0]))

        with self.assertRaisesRegex(ValueError, "system IDs must be unique"):
            load_raw(raw)

    def test_loader_rejects_duplicate_orbital_ids(self) -> None:
        raw = story_raw()
        orbitals = raw["systems"][0]["orbitals"]
        orbitals.append(copy.deepcopy(orbitals[0]))

        with self.assertRaisesRegex(ValueError, "duplicates"):
            load_raw(raw)

    def test_loader_rejects_unknown_moon_parent(self) -> None:
        raw = story_raw()
        raw["systems"][0]["orbitals"][1]["parent"] = "missing-parent"

        with self.assertRaisesRegex(ValueError, "parent references unknown orbital"):
            load_raw(raw)

    def test_loader_rejects_non_reciprocal_hops(self) -> None:
        raw = {
            "start_system": "a",
            "systems": [
                {
                    "id": "a",
                    "name": "A",
                    "star_type": "Unspecified",
                    "description": "",
                    "position_au": [0, 0],
                    "hops": ["b"],
                    "orbitals": [],
                },
                {
                    "id": "b",
                    "name": "B",
                    "star_type": "Unspecified",
                    "description": "",
                    "position_au": [1, 0],
                    "hops": [],
                    "orbitals": [],
                },
            ],
        }

        with self.assertRaisesRegex(ValueError, "must be reciprocal"):
            load_raw(raw)

    def test_loader_rejects_over_distance_hops(self) -> None:
        raw = {
            "start_system": "a",
            "systems": [
                {
                    "id": "a",
                    "name": "A",
                    "star_type": "Unspecified",
                    "description": "",
                    "position_au": [0, 0],
                    "hops": ["b"],
                    "orbitals": [],
                },
                {
                    "id": "b",
                    "name": "B",
                    "star_type": "Unspecified",
                    "description": "",
                    "position_au": [dq.MAX_HOP_DISTANCE_AU + 1, 0],
                    "hops": ["a"],
                    "orbitals": [],
                },
            ],
        }

        with self.assertRaisesRegex(ValueError, "exceeds"):
            load_raw(raw)

    def test_yaml_save_updates_only_yaml_story_file(self) -> None:
        raw = story_raw()
        with tempfile.TemporaryDirectory() as tmpdir:
            story_dir = Path(tmpdir)
            yaml_path = story_dir / "story.qualms.yaml"
            world = dq.load_world_from_raw(raw)
            from qualms.story_writer import write_story_world_yaml

            write_story_world_yaml(world, yaml_path)
            edited = dq.edit_system(world, yaml_path, world.start_system, "Edited", "Edited description.")

            self.assertEqual(edited.system_by_id(world.start_system).name, "Edited")
            self.assertEqual(dq.load_world(yaml_path).system_by_id(world.start_system).name, "Edited")
            self.assertTrue(yaml_path.read_text(encoding="utf-8").startswith("qualms:"))


class StoryBehaviorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.world = dq.load_world(STELLAR)
        self.state = dq.initial_game_state(self.world, editor_enabled=False)
        self.orbital = dq.orbital_by_id(self.world.system_by_id(self.state.system_id), self.state.orbital_id)

    def test_take_moves_object_to_inventory(self) -> None:
        bar = destination_by_ids(self.world, "mining-colony-5", "pointless-bar")
        self.state.current_location_id = bar.id
        choices = dq.object_choices_for_destination(self.state, bar)
        take = next(choice for choice in choices if choice.target.id == "portrait-of-enrick" and choice.interaction == "Take")

        dq.handle_interaction_choice(self.state, take, choice_index=0)

        self.assertIn("portrait-of-enrick", self.state.inventory)
        self.assertEqual(self.state.object_locations["portrait-of-enrick"], "inventory")
        self.assertFalse(self.state.continue_message)

    def test_before_rule_blocks_matching_interaction(self) -> None:
        bar = destination_by_ids(self.world, "mining-colony-5", "pointless-bar")
        self.state.current_location_id = bar.id
        talk = next(choice for choice in dq.npc_choices_for_destination(self.state, bar) if choice.target.id == "stu" and choice.interaction == "Talk")

        dq.handle_interaction_choice(self.state, talk, choice_index=0)

        self.assertEqual(self.state.continue_message, "We call him stupor for a reason.")

    def test_npc_examine_preserves_examine_description(self) -> None:
        bar = destination_by_ids(self.world, "mining-colony-5", "pointless-bar")
        self.state.current_location_id = bar.id
        examine = next(choice for choice in dq.npc_choices_for_destination(self.state, bar) if choice.target.id == "stu" and choice.interaction == "Examine")

        dq.handle_interaction_choice(self.state, examine, choice_index=0)

        self.assertEqual(
            self.state.continue_message,
            "His real name is Stu, but you call him 'Stupor' because you are very clever.",
        )

    def test_use_rule_sets_ship_control_after_message_sequence(self) -> None:
        portrait = dq.objects_by_id(self.world)["portrait-of-enrick"]
        console = dq.objects_by_id(self.world)["control-console"]
        self.state.inventory[portrait.id] = portrait
        self.state.object_locations[portrait.id] = "inventory"
        self.state.use_source_item_id = portrait.id
        self.state.use_return_view = "inventory"
        self.state.view = "use_room_target"

        dq.use_item_on_target(self.state, console)

        self.assertEqual(self.state.sequence_messages, ("The iris whirs with approval, and the console powers up.",))
        self.assertIsNone(self.state.use_source_item_id)
        dq.advance_sequence(self.state)
        self.assertEqual(self.state.player_ship_id, "canary")

    def test_destination_sequence_completes_after_messages(self) -> None:
        mining_colony = destination_by_ids(self.world, "mining-colony-5")
        self.state.facts.add("visited:destination:pointless-bar")
        self.state.facts.add("visited:destination:pointless-settlement")

        dq.enter_destination(self.state, mining_colony)

        self.assertEqual(len(self.state.sequence_messages), 1)
        self.assertNotIn("sequence:blemish-crash:complete", self.state.facts)
        dq.advance_sequence(self.state)
        self.assertIn("sequence:blemish-crash:complete", self.state.facts)

    def test_equipment_fact_unblocks_lunar_surface(self) -> None:
        lunar_surface = destination_by_ids(
            self.world,
            "mining-colony-5",
            "pointless-settlement",
            "airlock",
            "lunar-surface",
        )

        self.assertIn("cold-boiling", dq.destination_before_rule_message(self.state, lunar_surface))
        self.state.equipment["Exosuit"] = "spare-expedition-suit"
        self.assertIsNone(dq.destination_before_rule_message(self.state, lunar_surface))
        self.assertTrue(dq.state_has_fact(self.state, "equipped:slot:Exosuit"))

    def test_ship_board_takeoff_and_land(self) -> None:
        impact_crater = destination_by_ids(
            self.world,
            "mining-colony-5",
            "pointless-settlement",
            "airlock",
            "lunar-surface",
            "active-mine",
            "impact-crater",
        )
        self.state.current_location_id = impact_crater.id

        self.assertEqual(self.state.ship_locations["canary"], "impact-crater")
        dq.board_ship_at_destination(self.state, impact_crater)
        self.assertEqual(self.state.boarded_ship_id, "canary")

        self.state.player_ship_id = "canary"
        dq.take_off_from_destination(self.state)
        self.assertEqual(self.state.ship_locations["canary"], "orbit:empty-system:rainbow")
        self.assertEqual(self.state.docked_path, [])

        landing_path = dq.destination_path_by_ids(self.orbital, ("mining-colony-5",))
        dq.land_boarded_ship(self.state, self.orbital, list(landing_path))
        self.assertEqual(self.state.ship_locations["canary"], "mining-colony-5")
        self.assertIsNone(self.state.boarded_ship_id)

    def test_fuel_station_activation_and_refuel(self) -> None:
        platform = destination_by_ids_for_orbital(self.world, "empty-system", "bolorus", "abandoned-mining-platform")
        command_center = destination_by_ids_for_orbital(
            self.world,
            "empty-system",
            "bolorus",
            "abandoned-mining-platform",
            "command-tower",
            "command-center",
        )
        self.state.current_location_id = command_center.id
        power_up = next(
            choice
            for choice in dq.object_choices_for_destination(self.state, command_center)
            if choice.target.id == "fuel-station-controls" and choice.interaction == "Power up"
        )

        dq.handle_interaction_choice(self.state, power_up, choice_index=0)

        self.assertIn("fuel-station:fueling-station:active", self.state.facts)
        self.assertEqual(self.state.continue_message, "The old fueling station hums awake below.")
        examine_station = next(
            choice
            for choice in dq.object_choices_for_destination(self.state, platform)
            if choice.target.id == "fueling-station" and choice.interaction == "Examine"
        )
        self.state.current_location_id = platform.id
        dq.handle_interaction_choice(self.state, examine_station, choice_index=0)
        self.assertEqual(
            self.state.continue_message,
            "The old fueling station hums with enough life to top off the Canary.",
        )

        self.state.player_ship_id = "canary"
        self.state.boarded_ship_id = "canary"
        self.state.ship_locations["canary"] = "abandoned-mining-platform"
        self.state.ship_fuel["canary"] = 0

        self.assertTrue(dq.can_refuel_boarded_ship(self.state, platform, self.state.ships["canary"]))
        dq.refuel_boarded_ship(self.state, platform)

        self.assertEqual(self.state.ship_fuel["canary"], 3)
        self.assertEqual(self.state.continue_message, "Jump fuel replenished.")
        self.assertIn("fuel-station:fueling-station:empty", self.state.facts)
        self.assertFalse(dq.can_refuel_boarded_ship(self.state, platform, self.state.ships["canary"]))

        self.state.continue_message = ""
        dq.handle_interaction_choice(self.state, examine_station, choice_index=0)
        self.assertEqual(
            self.state.continue_message,
            "The old fueling station is powered up, but empty.",
        )

    def test_jump_consumes_fuel_and_blocks_without_it(self) -> None:
        abegna = self.world.system_by_id("abegna")
        self.state.player_ship_id = "canary"
        self.state.boarded_ship_id = "canary"
        self.state.ship_locations["canary"] = "system:empty-system"
        self.state.ship_fuel["canary"] = 1

        result = dq.jump_boarded_ship_to_system(self.state, abegna)

        self.assertEqual(result.status, "succeeded")
        self.assertEqual(self.state.system_id, "abegna")
        self.assertEqual(self.state.ship_locations["canary"], "system:abegna")
        self.assertEqual(self.state.ship_fuel["canary"], 0)

        self.state.system_id = "empty-system"
        self.state.ship_locations["canary"] = "system:empty-system"
        blocked = dq.jump_boarded_ship_to_system(self.state, abegna)

        self.assertEqual(blocked.status, "blocked")
        self.assertEqual(blocked.events[0]["text"], "The ship needs jump fuel.")
        self.assertEqual(self.state.system_id, "empty-system")

    def test_save_restore_round_trip_runtime_state(self) -> None:
        self.state.player_ship_id = "canary"
        self.state.boarded_ship_id = "canary"
        self.state.ship_locations["canary"] = "system:abegna"
        self.state.ship_fuel["canary"] = 2
        self.state.facts.add("fuel-station:fueling-station:active")

        saved = dq.game_state_to_save_data(self.state)
        restored = dq.restore_game_state(self.world, saved, editor_enabled=False)

        self.assertEqual(restored.player_ship_id, "canary")
        self.assertEqual(restored.boarded_ship_id, "canary")
        self.assertEqual(restored.ship_locations["canary"], "system:abegna")
        self.assertEqual(restored.ship_fuel["canary"], 2)
        self.assertIn("fuel-station:fueling-station:active", restored.facts)

    def test_inventory_portrait_description_is_not_wall_bound(self) -> None:
        portrait = dq.objects_by_id(self.world)["portrait-of-enrick"]
        self.state.inventory[portrait.id] = portrait
        self.state.object_locations[portrait.id] = "inventory"

        self.assertNotIn("hangs on the wall", self.state.inventory[portrait.id].description)


class StoryCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.world = dq.load_world(STELLAR)
        self.state = dq.initial_game_state(self.world, editor_enabled=False)

    def test_command_words_map_to_existing_keys(self) -> None:
        self.assertEqual(dq.command_to_key("continue", self.state), ord("1"))
        self.state.view = "system"

        self.assertEqual(dq.command_to_key("inventory", self.state), ord("i"))
        self.assertEqual(dq.command_to_key("go 2", self.state), ord("2"))
        self.assertEqual(dq.command_to_key("menu", self.state), ord("q"))
        self.assertEqual(dq.command_to_key("look", self.state), -1)

    def test_current_screen_lines_render_started_destination(self) -> None:
        self.state.view = "system"

        lines = dq.current_screen_lines(self.world, self.state)

        self.assertIn("Blemish: Mining Colony 5", lines[0])
        self.assertTrue(any("Pointless Bar" in line for line in lines))

    def test_adventure_screen_prints_visible_names_without_menu_numbers(self) -> None:
        lines = dq.adventure_screen_lines(self.world, self.state)
        commands = dq.command_words_for_state(self.world, self.state)

        self.assertIn("Blemish: Mining Colony 5", lines[0])
        self.assertTrue(any("Exits:" in line and "Pointless Bar" in line for line in lines))
        self.assertFalse(any(line.startswith("1.") for line in lines))
        self.assertIn("go Pointless Bar", commands)
        self.assertIn("save", commands)
        self.assertIn("restore", commands)
        self.assertIn("restart", commands)
        self.assertIn("quit", commands)
        self.assertNotIn("continue", commands)

    def test_editor_command_words_include_coauthor_prompt(self) -> None:
        state = dq.initial_game_state(self.world, editor_enabled=True)
        state.view = "system"

        commands = dq.command_words_for_state(self.world, state)

        self.assertIn("prompt", commands)

    def test_cli_render_prints_story_lines_without_status_bar(self) -> None:
        state = dq.initial_game_state(self.world, editor_enabled=True)
        state.view = "system"
        output = io.StringIO()

        with redirect_stdout(output):
            dq.render_cli_screen(self.world, state)

        text = output.getvalue()
        lines = text.splitlines()
        self.assertTrue(lines[1].startswith("Blemish: Mining Colony 5"))
        self.assertNotIn("Editing On", text)
        self.assertNotIn("\nEditor\n", text)
        self.assertNotIn("A: add", text)

    def test_cli_prompter_keeps_plain_mode_without_tty(self) -> None:
        with (
            patch.object(dq.sys, "stdin", Mock(isatty=lambda: False)),
            patch.object(dq.sys, "stdout", Mock(isatty=lambda: False)),
        ):
            prompter = dq.CliPrompter()

        self.assertIsNone(prompter._session)
        self.assertFalse(prompter._prompt_toolkit_available)

    def test_render_cli_lines_prints_direct_output_blocks(self) -> None:
        output = io.StringIO()

        with redirect_stdout(output):
            dq.render_cli_lines(["First room.", "", "A thing is here."])

        self.assertEqual(output.getvalue().splitlines(), ["", "First room.", "", "A thing is here."])

    def test_render_cli_lines_styles_title_and_generic_object_lists_on_tty(self) -> None:
        output = TtyStringIO()

        with redirect_stdout(output):
            dq.render_cli_lines(["First room.", "", "You see: Rock and Spade."])

        self.assertIn(f"{dq.CLI_BRIGHT}First room.{dq.CLI_RESET}", output.getvalue())
        self.assertIn(f"You see: {dq.CLI_BRIGHT}Rock and Spade{dq.CLI_RESET}.", output.getvalue())

    def test_render_cli_lines_styles_coauthor_transcript_on_tty(self) -> None:
        output = TtyStringIO()

        with redirect_stdout(output):
            dq.render_cli_lines(["Coauthor:", "Agent: added a room", "Tool call: qualms__validate {}"])

        text = output.getvalue()
        self.assertIn(f"{dq.CLI_CYAN}Agent: added a room{dq.CLI_RESET}", text)
        self.assertIn(f"{dq.CLI_GRAY}Tool call: qualms__validate {{}}{dq.CLI_RESET}", text)

    def test_render_cli_lines_skips_empty_blocks(self) -> None:
        output = io.StringIO()

        with redirect_stdout(output):
            dq.render_cli_lines([])

        self.assertEqual(output.getvalue(), "")

    def test_cli_prompter_prints_blank_line_before_command_prompt(self) -> None:
        with (
            patch.object(dq.sys, "stdin", Mock(isatty=lambda: False)),
            patch.object(dq.sys, "stdout", Mock(isatty=lambda: False)),
        ):
            prompter = dq.CliPrompter()
        output = io.StringIO()

        with patch("builtins.input", return_value="look"), redirect_stdout(output):
            command = prompter.read_command([])

        self.assertEqual(command, "look")
        self.assertEqual(output.getvalue(), "\n")

    def test_tab_toggle_enters_and_leaves_coauthor_mode(self) -> None:
        self.state.editor_enabled = True

        self.world, self.state, should_quit = dq.handle_cli_command(
            None,
            self.world,
            STELLAR,
            True,
            self.state,
            dq.CLI_TOGGLE_COAUTHOR,
        )

        self.assertFalse(should_quit)
        self.assertTrue(self.state.coauthor_mode)
        self.assertIn("Coauthor mode", self.state.message)

        self.world, self.state, should_quit = dq.handle_cli_command(
            None,
            self.world,
            STELLAR,
            True,
            self.state,
            dq.CLI_TOGGLE_COAUTHOR,
        )

        self.assertFalse(should_quit)
        self.assertFalse(self.state.coauthor_mode)
        self.assertEqual(self.state.message, "Story mode.")

    def test_editor_prompt_command_runs_coauthor_without_adventure_handling(self) -> None:
        result = SimpleNamespace(
            committed=False,
            transcript=[
                SimpleNamespace(kind="agent", content="Request: add a room", name=None),
                SimpleNamespace(kind="tool_call", content="{}", name="qualms__validate"),
                SimpleNamespace(kind="tool_result", content="Validation succeeded.", name="qualms__validate"),
            ],
            output=SimpleNamespace(
                message="Added a room.",
                summary="Added a room.",
                feedback=SimpleNamespace(confusing="none", tooling="none"),
            ),
        )
        self.state.editor_enabled = True

        with patch.object(dq, "run_coauthor_editor_prompt", return_value=result) as runner:
            self.world, self.state, should_quit = dq.handle_cli_command(
                None,
                self.world,
                STELLAR,
                True,
                self.state,
                "prompt: add a room",
            )

        self.assertFalse(should_quit)
        self.assertEqual(runner.call_args.args[:2], (STELLAR, "add a room"))
        self.assertIs(runner.call_args.args[2], self.state)
        self.assertIn("Coauthor:", self.state.message)
        self.assertIn("Tool call: qualms__validate {}", self.state.message)
        self.assertIn("Summary: Added a room.", self.state.message)

    def test_coauthor_mode_sends_plain_text_to_session_runner(self) -> None:
        result = SimpleNamespace(
            committed=False,
            transcript=[SimpleNamespace(kind="agent", content="No edits yet.", name=None)],
            output=SimpleNamespace(
                message="No edits yet.",
                summary="No edits yet.",
                feedback=SimpleNamespace(confusing="", tooling=""),
            ),
        )
        self.state.editor_enabled = True
        self.state.coauthor_mode = True
        self.state.gameplay_history = ["Story: Observation Deck", "Player: look"]

        with patch.object(dq, "run_coauthor_editor_prompt", return_value=result) as runner:
            self.world, self.state, should_quit = dq.handle_cli_command(
                None,
                self.world,
                STELLAR,
                True,
                self.state,
                "what should we add next?",
            )

        self.assertFalse(should_quit)
        self.assertEqual(runner.call_args.args[:2], (STELLAR, "what should we add next?"))
        self.assertIs(runner.call_args.args[2], self.state)
        self.assertIn("No edits yet.", self.state.message)

    def test_adventure_cli_only_reprints_location_on_change_or_look(self) -> None:
        mining_colony = destination_by_ids(self.world, "mining-colony-5")
        self.assertIn("Blemish: Mining Colony 5", dq.adventure_screen_lines(self.world, self.state)[0])
        self.assertEqual(dq.adventure_screen_lines(self.world, self.state), [])

        self.world, self.state, should_quit = dq.handle_cli_command(
            None,
            self.world,
            STELLAR,
            False,
            self.state,
            "inventory",
        )
        self.assertFalse(should_quit)
        self.assertEqual(dq.adventure_screen_lines(self.world, self.state), ["Inventory: empty."])

        self.world, self.state, should_quit = dq.handle_cli_command(
            None,
            self.world,
            STELLAR,
            False,
            self.state,
            "go Pointless Bar",
        )
        self.assertFalse(should_quit)
        self.assertIn("Blemish: Pointless Bar", dq.adventure_screen_lines(self.world, self.state)[0])

        self.world, self.state, should_quit = dq.handle_cli_command(
            None,
            self.world,
            STELLAR,
            False,
            self.state,
            "go Mining Colony 5",
        )
        self.assertFalse(should_quit)
        revisit_lines = dq.adventure_screen_lines(self.world, self.state)
        self.assertIn("Blemish: Mining Colony 5", revisit_lines[0])
        self.assertNotIn(mining_colony.description, "\n".join(revisit_lines))

        self.world, self.state, should_quit = dq.handle_cli_command(None, self.world, STELLAR, False, self.state, "look")
        self.assertFalse(should_quit)
        look_lines = dq.adventure_screen_lines(self.world, self.state)
        self.assertIn("Blemish: Mining Colony 5", look_lines[0])
        self.assertIn(mining_colony.description, "\n".join(look_lines))

    def test_adventure_cli_lists_jump_points_from_orbit(self) -> None:
        self.state.orbital_id = "rainbow"
        self.state.destination_path = []
        self.state.docked_path = []

        lines = dq.adventure_screen_lines(self.world, self.state)
        commands = dq.command_words_for_state(self.world, self.state)

        self.assertTrue(any(line == "Jump points: Abegna." for line in lines))
        self.assertIn("jump Abegna", commands)

    def test_adventure_cli_does_not_have_special_go_system_from_orbit(self) -> None:
        self.state.orbital_id = "rainbow"
        self.state.destination_path = []
        self.state.docked_path = []

        self.world, self.state, should_quit = dq.handle_cli_command(
            None,
            self.world,
            STELLAR,
            False,
            self.state,
            "go system",
        )

        self.assertFalse(should_quit)
        self.assertEqual(self.state.orbital_id, "rainbow")
        self.assertEqual(self.state.message, "You cannot go to system.")

    def test_adventure_cli_can_jump_from_orbital_orbit(self) -> None:
        self.state.orbital_id = "rainbow"
        self.state.destination_path = []
        self.state.docked_path = []
        self.state.boarded_ship_id = "canary"
        self.state.player_ship_id = "canary"
        self.state.ship_locations["canary"] = "orbit:empty-system:rainbow"
        self.state.ship_fuel["canary"] = 1

        self.world, self.state, should_quit = dq.handle_cli_command(
            None,
            self.world,
            STELLAR,
            False,
            self.state,
            "jump Abegna",
        )

        self.assertFalse(should_quit)
        self.assertEqual(self.state.system_id, "abegna")
        self.assertIsNone(self.state.orbital_id)
        self.assertEqual(self.state.ship_locations["canary"], "system:abegna")

    def test_adventure_cli_lists_parent_destinations_as_exits(self) -> None:
        self.world, self.state, should_quit = dq.handle_cli_command(
            None,
            self.world,
            STELLAR,
            False,
            self.state,
            "go Pointless Bar",
        )
        self.assertFalse(should_quit)
        lines = dq.adventure_screen_lines(self.world, self.state)

        self.assertTrue(any(line == "Exits: Mining Colony 5." for line in lines))

        self.world, self.state, should_quit = dq.handle_cli_command(
            None,
            self.world,
            STELLAR,
            False,
            self.state,
            "go Mining Colony 5",
        )
        self.assertFalse(should_quit)
        self.assertIn("Blemish: Mining Colony 5", dq.adventure_screen_lines(self.world, self.state)[0])

    def test_generic_cli_contract_and_view_for_stellar_story(self) -> None:
        definition = dq.load_game_definition(STELLAR)
        generic_state = dq.initial_generic_cli_state(definition)

        view = dq.generic_cli_view(generic_state)

        self.assertEqual(view.location.name, "Mining Colony 5")
        self.assertEqual([target.name for target in view.go_targets], ["Pointless Bar", "Pointless Settlement"])
        self.assertIn("go Pointless Bar", [action.command for action in view.actions])

        go_bar = next(action for action in view.actions if action.command == "go Pointless Bar")
        result = generic_state.engine.attempt(generic_state.runtime_state, dq.ActionAttempt(go_bar.action_id, go_bar.args))
        self.assertEqual(result.status, "succeeded")
        view = dq.generic_cli_view(generic_state)

        self.assertEqual(view.location.name, "Pointless Bar")
        self.assertIn("Mining Colony 5", [target.name for target in view.go_targets])
        self.assertIn("go Mining Colony 5", [action.command for action in view.actions])
        self.assertIn("Stu", [person.name for person in view.people])
        self.assertIn("Portrait of Enrick", [thing.name for thing in view.things])
        self.assertIn("take Portrait of Enrick", [action.command for action in view.actions])
        self.assertIn("talk to Stu", [action.command for action in view.actions])

        go_colony = next(action for action in view.actions if action.command == "go Mining Colony 5")
        result = generic_state.engine.attempt(generic_state.runtime_state, dq.ActionAttempt(go_colony.action_id, go_colony.args))
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(dq.generic_cli_view(generic_state).location.name, "Mining Colony 5")

    def test_generic_cli_contract_reports_missing_core_support(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "bad.qualms.yaml"
            path.write_text(
                """
qualms: "0.1"
id: bad-cli-story
story:
  entities:
    - id: player
""".strip()
                + "\n",
                encoding="utf-8",
            )
            definition = dq.load_game_definition(path)

        with self.assertRaisesRegex(dq.GenericCliContractError, "Generic CLI requires core prelude support"):
            dq.validate_generic_cli_contract(definition)

    def test_generic_cli_screen_prints_visible_world_without_ev_labels(self) -> None:
        definition = dq.load_game_definition(STELLAR)
        state = dq.initial_generic_cli_state(definition)

        lines = dq.generic_cli_screen_lines(state)
        commands = dq.generic_command_words_for_state(state)

        self.assertEqual(lines[0], "Mining Colony 5")
        self.assertTrue(any("You can go to Pointless Bar and Pointless Settlement." == line for line in lines))
        self.assertNotIn("Exits", "\n".join(lines))
        self.assertIn("go Pointless Bar", commands)
        self.assertIn("save", commands)
        self.assertIn("restore", commands)
        self.assertIn("restart", commands)
        self.assertIn("quit", commands)
        self.assertNotIn("continue", commands)

    def test_generic_cli_includes_parent_destinations_as_go_targets(self) -> None:
        definition = dq.load_game_definition(STELLAR)
        state = dq.initial_generic_cli_state(definition)

        state, should_quit = dq.handle_generic_cli_command(state, "go Pointless Settlement", STELLAR)
        self.assertFalse(should_quit)
        view = dq.generic_cli_view(state)
        self.assertEqual(
            [target.name for target in view.go_targets],
            ["Your place", "Airlock", "Mining Colony 5"],
        )

        state, should_quit = dq.handle_generic_cli_command(state, "go Your place", STELLAR)
        self.assertFalse(should_quit)
        view = dq.generic_cli_view(state)
        self.assertEqual([target.name for target in view.go_targets], ["Pointless Settlement"])

    def test_generic_cli_only_reprints_location_on_change_or_look(self) -> None:
        definition = dq.load_game_definition(STELLAR)
        state = dq.initial_generic_cli_state(definition)

        self.assertIn("Mining Colony 5", dq.generic_cli_screen_lines(state)[0])
        self.assertEqual(dq.generic_cli_screen_lines(state), [])

        state, should_quit = dq.handle_generic_cli_command(state, "inventory", STELLAR)
        self.assertFalse(should_quit)
        self.assertEqual(dq.generic_cli_screen_lines(state), ["Inventory: empty."])

        state, should_quit = dq.handle_generic_cli_command(state, "go Pointless Bar", STELLAR)
        self.assertFalse(should_quit)
        self.assertIn("Pointless Bar", dq.generic_cli_screen_lines(state)[0])

        state, should_quit = dq.handle_generic_cli_command(state, "look", STELLAR)
        self.assertFalse(should_quit)
        self.assertIn("Pointless Bar", dq.generic_cli_screen_lines(state)[0])

    def test_generic_cli_messages_are_not_modal(self) -> None:
        definition = dq.load_game_definition(STELLAR)
        state = dq.initial_generic_cli_state(definition)
        dq.generic_cli_screen_lines(state)
        state, should_quit = dq.handle_generic_cli_command(state, "go Pointless Bar", STELLAR)
        self.assertFalse(should_quit)
        dq.generic_cli_screen_lines(state)

        state, should_quit = dq.handle_generic_cli_command(state, "examine Portrait of Enrick", STELLAR)
        self.assertFalse(should_quit)
        lines = dq.generic_cli_screen_lines(state)

        self.assertFalse(state.pending_messages)
        self.assertTrue(any("Everyone's favorite" in line for line in lines))
        self.assertNotIn("continue", "\n".join(lines).lower())

    def test_generic_cli_commands_drive_story_and_builtin_save_restore(self) -> None:
        definition = dq.load_game_definition(STELLAR)
        state = dq.initial_generic_cli_state(definition)

        state, should_quit = dq.handle_generic_cli_command(state, "go Pointless Bar", STELLAR)
        self.assertFalse(should_quit)
        self.assertEqual(dq.generic_cli_view(state).location.name, "Pointless Bar")

        state, should_quit = dq.handle_generic_cli_command(state, "take Portrait of Enrick", STELLAR)
        self.assertFalse(should_quit)
        self.assertIn("Portrait of Enrick", [item.name for item in dq.generic_cli_view(state).inventory])

        with tempfile.TemporaryDirectory() as tmpdir:
            save_path = Path(tmpdir) / "generic.save.json"
            state, should_quit = dq.handle_generic_cli_command(state, f"save {save_path}", STELLAR)
            self.assertFalse(should_quit)
            self.assertTrue(save_path.exists())

            state, should_quit = dq.handle_generic_cli_command(state, "restart", STELLAR)
            self.assertFalse(should_quit)
            self.assertNotIn("Portrait of Enrick", [item.name for item in dq.generic_cli_view(state).inventory])

            state, should_quit = dq.handle_generic_cli_command(state, f"restore {save_path}", STELLAR)
            self.assertFalse(should_quit)
            self.assertIn("Portrait of Enrick", [item.name for item in dq.generic_cli_view(state).inventory])

        state, should_quit = dq.handle_generic_cli_command(state, "quit", STELLAR)
        self.assertTrue(should_quit)

    def test_cli_text_commands_drive_story_and_builtin_save_restore(self) -> None:
        self.world, self.state, should_quit = dq.handle_cli_command(
            None,
            self.world,
            STELLAR,
            False,
            self.state,
            "go Pointless Bar",
        )
        self.assertFalse(should_quit)
        self.assertEqual(dq.current_destination(self.world, self.state).id, "pointless-bar")

        self.world, self.state, should_quit = dq.handle_cli_command(
            None,
            self.world,
            STELLAR,
            False,
            self.state,
            "take Portrait of Enrick",
        )
        self.assertFalse(should_quit)
        self.assertIn("portrait-of-enrick", self.state.inventory)

        with tempfile.TemporaryDirectory() as tmpdir:
            save_path = Path(tmpdir) / "game.save.json"
            self.world, self.state, should_quit = dq.handle_cli_command(
                None,
                self.world,
                STELLAR,
                False,
                self.state,
                f"save {save_path}",
            )
            self.assertFalse(should_quit)
            self.assertTrue(save_path.exists())

            self.state.inventory.clear()
            self.world, self.state, should_quit = dq.handle_cli_command(
                None,
                self.world,
                STELLAR,
                False,
                self.state,
                f"restore {save_path}",
            )
            self.assertFalse(should_quit)
            self.assertIn("portrait-of-enrick", self.state.inventory)

        self.world, self.state, should_quit = dq.handle_cli_command(None, self.world, STELLAR, False, self.state, "restart")
        self.assertFalse(should_quit)
        self.assertNotIn("portrait-of-enrick", self.state.inventory)

        self.world, self.state, should_quit = dq.handle_cli_command(None, self.world, STELLAR, False, self.state, "quit")
        self.assertTrue(should_quit)


if __name__ == "__main__":
    unittest.main()

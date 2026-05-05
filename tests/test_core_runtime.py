from __future__ import annotations

import unittest

from qualms import (
    ActionAttempt,
    ActionDefinition,
    ActionPattern,
    EntitySpec,
    FieldDefinition,
    GameDefinition,
    ParameterDefinition,
    RelationDefinition,
    Rule,
    RulesEngine,
    TraitAttachment,
    TraitDefinition,
)


def movement_definition(*rules: Rule, extra_relations=(), extra_actions=()) -> GameDefinition:
    location = TraitDefinition(id="Location")
    relocatable = TraitDefinition(
        id="Relocatable",
        fields=(FieldDefinition(id="location", type="ref<Location>?", default=None),),
    )
    at = RelationDefinition(
        id="At",
        parameters=(
            ParameterDefinition("subject", "ref<Relocatable>"),
            ParameterDefinition("location", "ref<Location>"),
        ),
        get={
            "eq": [
                {"field": {"entity": {"var": "subject"}, "trait": "Relocatable", "field": "location"}},
                {"var": "location"},
            ]
        },
        set_effects=(
            {
                "set_field": {
                    "entity": {"var": "subject"},
                    "trait": "Relocatable",
                    "field": "location",
                    "value": {"var": "location"},
                }
            },
        ),
    )
    nearby = RelationDefinition(
        id="Nearby",
        parameters=(
            ParameterDefinition("left", "ref<Location>"),
            ParameterDefinition("right", "ref<Location>"),
        ),
        get={"eq": [{"var": "left"}, {"var": "right"}]},
    )
    move = ActionDefinition(
        id="Move",
        parameters=(
            ParameterDefinition("actor", "entity?"),
            ParameterDefinition("subject", "ref<Relocatable>"),
            ParameterDefinition("destination", "ref<Location>"),
        ),
        default_effects=(
            {
                "assert": {
                    "relation": "At",
                    "args": [{"var": "subject"}, {"var": "destination"}],
                }
            },
        ),
    )
    return GameDefinition(
        traits={trait.id: trait for trait in (location, relocatable)},
        relations={relation.id: relation for relation in (at, nearby, *extra_relations)},
        actions={action.id: action for action in (move, *extra_actions)},
        rules=rules,
        initial_entities=(
            EntitySpec(id="player"),
            EntitySpec(id="room-a", traits=(TraitAttachment("Location"),)),
            EntitySpec(id="room-b", traits=(TraitAttachment("Location"),)),
            EntitySpec(id="box", traits=(TraitAttachment("Relocatable"),)),
        ),
        initial_assertions=(
            {"relation": "At", "args": [{"ref": "box"}, {"ref": "room-a"}]},
        ),
    )


def move_box(destination: str = "room-b") -> ActionAttempt:
    return ActionAttempt(
        "Move",
        {
            "actor": "player",
            "subject": "box",
            "destination": destination,
        },
    )


class CoreRuntimeTests(unittest.TestCase):
    def test_writable_relation_can_be_tested_and_asserted(self) -> None:
        definition = movement_definition()
        state = definition.instantiate()

        self.assertTrue(state.test("At", ["box", "room-a"]))
        self.assertFalse(state.test("At", ["box", "room-b"]))

        state.assert_relation("At", ["box", "room-b"])

        self.assertFalse(state.test("At", ["box", "room-a"]))
        self.assertTrue(state.test("At", ["box", "room-b"]))

    def test_pure_relation_cannot_be_asserted(self) -> None:
        definition = movement_definition()
        state = definition.instantiate()

        with self.assertRaisesRegex(ValueError, "not writable"):
            state.assert_relation("Nearby", ["room-a", "room-b"])

    def test_stored_remembered_relation_can_be_asserted_and_retracted(self) -> None:
        visited = RelationDefinition(
            id="Visited",
            parameters=(
                ParameterDefinition("actor", "entity"),
                ParameterDefinition("location", "ref<Location>"),
            ),
            persistence="remembered",
        )
        forget = ActionDefinition(
            id="ForgetVisit",
            parameters=(
                ParameterDefinition("actor", "entity"),
                ParameterDefinition("location", "ref<Location>"),
            ),
            default_effects=(
                {
                    "retract": {
                        "relation": "Visited",
                        "args": [{"var": "actor"}, {"var": "location"}],
                    }
                },
            ),
        )
        definition = movement_definition(extra_relations=(visited,), extra_actions=(forget,))
        state = definition.instantiate()

        state.assert_relation("Visited", ["player", "room-a"])
        self.assertTrue(state.test("Visited", ["player", "room-a"]))
        self.assertIn(("Visited", ("player", "room-a")), state.remembered_relations)
        self.assertNotIn(("Visited", ("player", "room-a")), state.current_relations)

        result = RulesEngine(definition).attempt(
            state,
            ActionAttempt("ForgetVisit", {"actor": "player", "location": "room-a"}),
        )

        self.assertTrue(result.succeeded)
        self.assertFalse(state.test("Visited", ["player", "room-a"]))

    def test_action_default_effects_apply_without_rules(self) -> None:
        definition = movement_definition()
        state = definition.instantiate()
        result = RulesEngine(definition).attempt(state, move_box())

        self.assertTrue(result.succeeded)
        self.assertTrue(state.test("At", ["box", "room-b"]))

    def test_before_stop_blocks_default_behavior_but_commits_rule_effects(self) -> None:
        rule = Rule(
            id="block-move",
            phase="before",
            pattern=ActionPattern("Move", {"subject": {"ref": "box"}}),
            effects=({"emit": {"text": "Blocked."}},),
            control="stop",
        )
        definition = movement_definition(rule)
        state = definition.instantiate()

        result = RulesEngine(definition).attempt(state, move_box())

        self.assertEqual(result.status, "blocked")
        self.assertEqual(result.events, ({"text": "Blocked.", "type": "emit"},))
        self.assertTrue(state.test("At", ["box", "room-a"]))

    def test_instead_stop_replaces_default_behavior_and_after_still_runs(self) -> None:
        instead = Rule(
            id="replace-move",
            phase="instead",
            pattern=ActionPattern("Move"),
            effects=(
                {"emit": {"text": "Instead."}},
                {"set_fact": {"id": "Replaced", "args": [{"var": "subject"}]}},
            ),
            control="stop",
        )
        after = Rule(
            id="after-move",
            phase="after",
            pattern=ActionPattern("Move"),
            effects=({"emit": {"text": "After."}},),
        )
        definition = movement_definition(instead, after)
        state = definition.instantiate()

        result = RulesEngine(definition).attempt(state, move_box())

        self.assertEqual(result.status, "succeeded")
        self.assertEqual([event["text"] for event in result.events], ["Instead.", "After."])
        self.assertTrue(state.memory.has("Replaced", ["box"]))
        self.assertTrue(state.test("At", ["box", "room-a"]))

    def test_rule_order_is_priority_then_document_order(self) -> None:
        rules = (
            Rule(
                id="third",
                phase="after",
                priority=10,
                order=0,
                pattern=ActionPattern("Move"),
                effects=({"emit": {"text": "third"}},),
            ),
            Rule(
                id="second",
                phase="after",
                priority=0,
                order=2,
                pattern=ActionPattern("Move"),
                effects=({"emit": {"text": "second"}},),
            ),
            Rule(
                id="first",
                phase="after",
                priority=0,
                order=1,
                pattern=ActionPattern("Move"),
                effects=({"emit": {"text": "first"}},),
            ),
        )
        definition = movement_definition(*rules)
        state = definition.instantiate()

        result = RulesEngine(definition).attempt(state, move_box())

        self.assertEqual([event["text"] for event in result.events], ["first", "second", "third"])

    def test_effects_do_not_recursively_trigger_action_rules(self) -> None:
        spawn = ActionDefinition(
            id="Spawn",
            parameters=(ParameterDefinition("location", "ref<Location>"),),
            default_effects=(
                {"create": {"bind": "enemy", "id": {"allocate": "enemy"}, "traits": [{"id": "Relocatable"}]}},
                {"assert": {"relation": "At", "args": [{"var": "enemy"}, {"var": "location"}]}},
            ),
        )
        move_after = Rule(
            id="after-move",
            phase="after",
            pattern=ActionPattern("Move"),
            effects=({"set_fact": {"id": "Moved"}},),
        )
        definition = movement_definition(move_after, extra_actions=(spawn,))
        state = definition.instantiate()

        result = RulesEngine(definition).attempt(state, ActionAttempt("Spawn", {"location": "room-b"}))

        self.assertTrue(result.succeeded)
        self.assertIn("enemy-1", state.entities)
        self.assertTrue(state.test("At", ["enemy-1", "room-b"]))
        self.assertFalse(state.memory.has("Moved"))

    def test_failed_effect_rolls_back_action_transaction(self) -> None:
        after = Rule(
            id="bad-after",
            phase="after",
            pattern=ActionPattern("Move"),
            effects=({"assert": {"relation": "Nearby", "args": [{"ref": "room-a"}, {"ref": "room-b"}]}},),
        )
        definition = movement_definition(after)
        state = definition.instantiate()

        result = RulesEngine(definition).attempt(state, move_box())

        self.assertEqual(result.status, "failed")
        self.assertIn("not writable", result.error)
        self.assertTrue(state.test("At", ["box", "room-a"]))
        self.assertFalse(state.test("At", ["box", "room-b"]))


if __name__ == "__main__":
    unittest.main()

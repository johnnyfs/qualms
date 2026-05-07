from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

ObjectInteraction = Literal["Examine", "Power up", "Take", "Use"]
NpcInteraction = Literal["Examine", "Talk"]


class CoauthorFeedback(BaseModel):
    """Editor-facing feedback about the authoring system."""

    confusing: str = Field(
        default="",
        description="What was confusing or underspecified about the story model, prompt, or available tools.",
    )
    tooling: str = Field(
        default="",
        description="Concrete changes to tools, schemas, or prompt context that would make future edits easier.",
    )


class CoauthorOutput(BaseModel):
    """Final structured response from the coauthor model."""

    message: str = Field(
        default="",
        description="Conversational response to the user. Ask clarification here when no edit should be made yet.",
    )
    summary: str = Field(description="What changed in the story model and why.")
    feedback: CoauthorFeedback = Field(description="Authoring-system feedback from this run.")


class CoauthorTranscriptEvent(BaseModel):
    kind: Literal["agent", "agent_delta", "tool_call", "tool_result", "status", "error"]
    content: str
    name: str | None = None
    data: Any | None = None


class CoauthorRunResult(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    output: CoauthorOutput
    transcript: list[CoauthorTranscriptEvent] = Field(default_factory=list)
    committed: bool = False
    message_history: list[Any] = Field(default_factory=list)


class ToolResult(BaseModel):
    ok: bool = True
    message: str
    data: Any | None = None


class PresentablePatch(BaseModel):
    name: str | None = Field(default=None, description="Replacement display name.")
    description: str | None = Field(default=None, description="Replacement room/object description.")
    examine_description: str | None = Field(default=None, description="Replacement examine text, when distinct.")


class TraitAttachmentPatch(BaseModel):
    id: str = Field(description="Trait id to add or replace.")
    fields: dict[str, Any] = Field(default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)


class EntityUpdate(BaseModel):
    id: str = Field(description="Entity id to update.")
    kind: str | None = Field(default=None, description="Replacement kind id.")
    presentable: PresentablePatch | None = None
    traits_add: list[TraitAttachmentPatch] = Field(default_factory=list)
    traits_remove: list[str] = Field(default_factory=list)
    fields_merge: dict[str, dict[str, Any]] = Field(
        default_factory=dict,
        description="Trait field values to merge into entity.fields, keyed by trait id.",
    )
    metadata_merge: dict[str, Any] = Field(
        default_factory=dict,
        description="Metadata values to merge into entity.metadata.",
    )
    rules_replace: list[dict[str, Any]] | None = Field(
        default=None,
        description="Complete replacement for local entity rules. Use sparingly.",
    )


class DestinationCreate(BaseModel):
    parent_id: str = Field(description="Existing Location entity id that will contain this destination.")
    id: str = Field(description="Full entity id, or a local id to append to parent_id.")
    name: str
    description: str
    display_kind: str = "Destination"
    port: bool = False
    visible_when: list[str] = Field(default_factory=list)
    visible_unless: list[str] = Field(default_factory=list)


class StoryObjectCreate(BaseModel):
    location_id: str = Field(description="Existing Location entity id where the object starts.")
    id: str = Field(description="Full entity id, or a local id to append as location_id:object:id.")
    name: str
    description: str
    collectable: bool = False
    interactions: list[ObjectInteraction] = Field(
        default_factory=list,
        description=(
            "Legacy CLI object interactions. Refuel is not an object interaction; "
            "set fuel_station=true and the game exposes the refuel command from that location."
        ),
    )
    equipment_slot: str | None = None
    fuel_station: bool = False
    visible_when: list[str] = Field(default_factory=list)
    visible_unless: list[str] = Field(default_factory=list)


class NpcCreate(BaseModel):
    location_id: str = Field(description="Existing Location entity id where the NPC starts.")
    id: str = Field(description="Full entity id, or a local id to append as location_id:npc:id.")
    name: str
    description: str
    examine_description: str | None = None
    interactions: list[NpcInteraction] = Field(default_factory=list)
    visible_when: list[str] = Field(default_factory=list)
    visible_unless: list[str] = Field(default_factory=list)


class ShipCreate(BaseModel):
    id: str = Field(description="Full ship entity id, or a local id at top level.")
    name: str
    description: str
    docked_at_id: str | None = Field(default=None, description="Destination where the ship is docked.")
    at_id: str | None = Field(default=None, description="Location for a plain At assertion when not docked.")
    controlled_by_actor_id: str | None = Field(default=None, description="Actor id that controls the ship.")
    abilities: list[str] = Field(default_factory=list)
    equipment_slots: list[str] = Field(default_factory=list)
    unlock: bool = False
    visible_when: list[str] = Field(default_factory=list)
    visible_unless: list[str] = Field(default_factory=list)


class PathCreate(BaseModel):
    source_id: str = Field(description="Source Location id.")
    target_id: str = Field(description="Target Location id.")
    bidirectional: bool = Field(default=False, description="Also add the reverse Path assertion.")


class AssertionCreate(BaseModel):
    relation: str
    refs: list[str] = Field(description="Reference args for the assertion, in relation parameter order.")


class DeleteEntity(BaseModel):
    id: str
    cascade_assertions: bool = Field(
        default=False,
        description="When true, also delete top-level assertions that directly reference this entity.",
    )

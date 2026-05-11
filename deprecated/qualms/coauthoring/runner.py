from __future__ import annotations

from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Callable

from .config import CoauthorConfig, load_coauthor_config
from .models import (
    AssertionCreate,
    CoauthorFeedback,
    CoauthorOutput,
    CoauthorRunResult,
    CoauthorTranscriptEvent,
    DeleteEntity,
    DestinationCreate,
    EntityUpdate,
    NpcCreate,
    PathCreate,
    ShipCreate,
    StoryObjectCreate,
    ToolResult,
)
from .workspace import CoauthorWorkspace


ProgressCallback = Callable[[CoauthorTranscriptEvent], None]


@dataclass
class CoauthorSession:
    message_history: list[Any] = field(default_factory=list)


def run_coauthor_prompt(
    path: str | Path,
    prompt: str,
    *,
    session: CoauthorSession | None = None,
    gameplay_history: str = "",
    progress: ProgressCallback | None = None,
) -> CoauthorRunResult:
    workspace = CoauthorWorkspace(path)
    config = load_coauthor_config(workspace.path)
    snapshot = workspace.snapshot()
    transcript: list[CoauthorTranscriptEvent] = []
    emit(transcript, progress, CoauthorTranscriptEvent(kind="status", content="Coauthor running."))
    emit(transcript, progress, CoauthorTranscriptEvent(kind="agent", content=f"Request: {prompt}"))

    try:
        require_provider_key(config)
        output, message_history = run_pydantic_agent(
            workspace,
            config,
            prompt,
            transcript,
            message_history=session.message_history if session is not None else [],
            gameplay_history=gameplay_history,
            progress=progress,
        )
        validation = workspace.validate()
        emit(
            transcript,
            progress,
            CoauthorTranscriptEvent(
                kind="tool_result",
                name="qualms__validate",
                content=validation.message,
                data=validation.model_dump(),
            )
        )
        if not validation.ok:
            workspace.rollback(snapshot)
            output = CoauthorOutput(
                message=f"I could not commit the change because validation failed: {validation.message}",
                summary=f"No changes committed. {validation.message}",
                feedback=output.feedback,
            )
            emit(transcript, progress, CoauthorTranscriptEvent(kind="error", content=validation.message))
            if session is not None:
                session.message_history = message_history
            return CoauthorRunResult(output=output, transcript=transcript, committed=False, message_history=message_history)
        workspace.save()
        if session is not None:
            session.message_history = message_history
        emit(transcript, progress, CoauthorTranscriptEvent(kind="agent", content=output.message or output.summary))
        return CoauthorRunResult(output=output, transcript=transcript, committed=True, message_history=message_history)
    except Exception as error:
        workspace.rollback(snapshot)
        emit(transcript, progress, CoauthorTranscriptEvent(kind="error", content=str(error)))
        return CoauthorRunResult(
            output=CoauthorOutput(
                message=f"I could not run the coauthor turn: {error}",
                summary=f"No changes committed. {error}",
                feedback=CoauthorFeedback(confusing="", tooling=""),
            ),
            transcript=transcript,
            committed=False,
            message_history=session.message_history if session is not None else [],
        )


def require_provider_key(config: CoauthorConfig) -> None:
    model = config.model.lower()
    if model.startswith("anthropic:") and not config.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is required for QUALMS_COAUTHOR_MODEL starting with anthropic:")
    if model.startswith(("openai:", "openai-responses:")) and not config.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is required for QUALMS_COAUTHOR_MODEL starting with openai:")


def run_pydantic_agent(
    workspace: CoauthorWorkspace,
    config: CoauthorConfig,
    prompt: str,
    transcript: list[CoauthorTranscriptEvent],
    *,
    message_history: list[Any],
    gameplay_history: str,
    progress: ProgressCallback | None,
) -> tuple[CoauthorOutput, list[Any]]:
    try:
        from pydantic_ai import Agent
    except ModuleNotFoundError as error:
        raise RuntimeError("Install pydantic-ai to use the editor coauthor prompt.") from error

    agent = Agent(
        config.model,
        output_type=CoauthorOutput,
        instructions=build_coauthor_instructions(workspace),
        tools=coauthor_tools(workspace, transcript, config.max_tool_calls, progress),
        max_concurrency=1,
    )
    result = agent.run_sync(
        prompt,
        message_history=message_history,
        instructions=turn_instructions(gameplay_history),
        event_stream_handler=stream_text_handler(transcript, progress),
    )
    try:
        history = result.all_messages(output_tool_return_content=result.output.message or result.output.summary)
    except ValueError:
        history = result.all_messages()
    return result.output, history


def coauthor_tools(
    workspace: CoauthorWorkspace,
    transcript: list[CoauthorTranscriptEvent],
    max_tool_calls: int,
    progress: ProgressCallback | None = None,
) -> list[Callable[..., ToolResult]]:
    calls = {"count": 0}

    def invoke(name: str, args: Any, fn: Callable[[], ToolResult]) -> ToolResult:
        calls["count"] += 1
        if calls["count"] > max_tool_calls:
            result = ToolResult(ok=False, message=f"Tool call limit exceeded ({max_tool_calls}).")
            emit(transcript, progress, CoauthorTranscriptEvent(kind="tool_result", name=name, content=result.message, data=result.model_dump()))
            return result
        emit(transcript, progress, CoauthorTranscriptEvent(kind="tool_call", name=name, content=compact_args(args), data=args))
        try:
            result = fn()
        except Exception as error:
            result = ToolResult(ok=False, message=str(error))
        emit(transcript, progress, CoauthorTranscriptEvent(kind="tool_result", name=name, content=result.message, data=result.model_dump()))
        return result

    def qualms__list_entities(
        kind: str | None = None,
        parent: str | None = None,
        with_trait: str | None = None,
        name_contains: str | None = None,
        editable_only: bool = False,
    ) -> ToolResult:
        """List story entities. Filters are exact except name_contains."""
        args = {
            "kind": kind,
            "parent": parent,
            "with_trait": with_trait,
            "name_contains": name_contains,
            "editable_only": editable_only,
        }
        return invoke("qualms__list_entities", args, lambda: workspace.list_entities(**args))

    def qualms__get_entity(id: str) -> ToolResult:
        """Get one entity by id, including whether it is editable top-level story data."""
        return invoke("qualms__get_entity", {"id": id}, lambda: workspace.get_entity(id))

    def qualms__create_destination(value: DestinationCreate) -> ToolResult:
        """Create a Destination and its At assertion under an existing Location."""
        return invoke("qualms__create_destination", value.model_dump(), lambda: workspace.create_destination(value))

    def qualms__create_object(value: StoryObjectCreate) -> ToolResult:
        """Create a StoryObject and its At assertion in an existing Location."""
        return invoke("qualms__create_object", value.model_dump(), lambda: workspace.create_object(value))

    def qualms__create_npc(value: NpcCreate) -> ToolResult:
        """Create an NPC and its At assertion in an existing Location."""
        return invoke("qualms__create_npc", value.model_dump(), lambda: workspace.create_npc(value))

    def qualms__create_ship(value: ShipCreate) -> ToolResult:
        """Create a Ship entity and optional DockedAt, At, and ControlledBy assertions."""
        return invoke("qualms__create_ship", value.model_dump(), lambda: workspace.create_ship(value))

    def qualms__connect_path(value: PathCreate) -> ToolResult:
        """Create one or two Path assertions between existing Location entities."""
        return invoke("qualms__connect_path", value.model_dump(), lambda: workspace.connect_path(value))

    def qualms__create_assertion(value: AssertionCreate) -> ToolResult:
        """Create a raw relation assertion with ref args. Prefer specific tools when available."""
        return invoke("qualms__create_assertion", value.model_dump(), lambda: workspace.create_assertion(value))

    def qualms__update_entity(value: EntityUpdate) -> ToolResult:
        """Update one editable top-level entity with explicit patch fields."""
        return invoke("qualms__update_entity", value.model_dump(), lambda: workspace.update_entity(value))

    def qualms__delete_entity(value: DeleteEntity) -> ToolResult:
        """Delete one editable top-level entity, optionally removing direct assertions."""
        return invoke("qualms__delete_entity", value.model_dump(), lambda: workspace.delete_entity(value))

    def qualms__find_references(id: str) -> ToolResult:
        """Find top-level story references to an entity before deleting or changing ids."""
        return invoke("qualms__find_references", {"id": id}, lambda: ToolResult(message=f"Found references for {id}.", data=workspace.find_references(id)))

    def qualms__list_definitions(type: str) -> ToolResult:
        """List trait, kind, relation, action, or rule definitions from story plus read-only imports."""
        return invoke("qualms__list_definitions", {"type": type}, lambda: workspace.list_definitions(type))

    def qualms__get_definition(type: str, id: str) -> ToolResult:
        """Get one trait, kind, relation, action, or rule definition."""
        return invoke("qualms__get_definition", {"type": type, "id": id}, lambda: workspace.get_definition(type, id))

    def qualms__validate() -> ToolResult:
        """Validate the current edited story model before finalizing."""
        return invoke("qualms__validate", {}, workspace.validate)

    return [
        qualms__list_entities,
        qualms__get_entity,
        qualms__create_destination,
        qualms__create_object,
        qualms__create_npc,
        qualms__create_ship,
        qualms__connect_path,
        qualms__create_assertion,
        qualms__update_entity,
        qualms__delete_entity,
        qualms__find_references,
        qualms__list_definitions,
        qualms__get_definition,
        qualms__validate,
    ]


def build_coauthor_instructions(workspace: CoauthorWorkspace) -> str:
    docs = associated_markdown_context(workspace.path)
    return "\n\n".join(
        [
            "You are the Qualms embedded coauthor. Edit the currently running story model only through tools.",
            "The top-level story file is editable. Imported prelude files are read-only context; if the request requires prelude or engine changes, say so in feedback instead of trying to work around it.",
            "The model is object-based: entities have ids, optional kinds, trait attachments, trait field values, metadata, and local rules. Assertions establish starting relations such as At, DockedAt, ControlledBy, and Path. Facts seed remembered flags. Kinds and traits come from definitions in the imported preludes.",
            "You are in a conversational editor session. Talk with the user about proposed story changes, clarify ambiguous requests before editing, and respond to follow-up comments in context.",
            "Keep descriptions state-neutral. A location or object description should describe stable qualities, not transient presence such as 'the ship is here', 'the NPC waits here', or 'the door is open' if those things can change. Put current placement and mutable state in assertions, facts, fields, or rules instead.",
            "Legacy object interactions are only Examine, Take, Use, and Power up. Refuel is not an object interaction; an active FuelStation object enables the player's refuel command from that location.",
            "Prefer object-specific tools over raw assertions or entity updates. Inspect relevant entities and definitions before edits. Keep ids stable unless the user explicitly asks for a rename. Always validate after changes.",
            "Return a structured response with message, summary, and feedback. The message is what the user sees conversationally. The summary should say what changed and why, or say no changes were made. Feedback should name confusing schema or tool gaps that slowed the edit.",
            docs,
        ]
    )


def turn_instructions(gameplay_history: str) -> str:
    if not gameplay_history.strip():
        return "No gameplay transcript has been captured yet."
    return "Recent gameplay transcript visible to the player:\n" + gameplay_history.strip()


def stream_text_handler(
    transcript: list[CoauthorTranscriptEvent],
    progress: ProgressCallback | None,
) -> Callable[..., Any] | None:
    if progress is None:
        return None

    async def handle(_ctx: Any, stream: Any) -> None:
        async for event in stream:
            part = getattr(event, "part", None)
            part_content = getattr(part, "content", None)
            if getattr(event, "event_kind", "") == "part_start" and isinstance(part_content, str) and part_content:
                emit(transcript, progress, CoauthorTranscriptEvent(kind="agent_delta", content=part_content))
            delta = getattr(event, "delta", None)
            content_delta = getattr(delta, "content_delta", None)
            if content_delta:
                emit(transcript, progress, CoauthorTranscriptEvent(kind="agent_delta", content=str(content_delta)))

    return handle


def emit(
    transcript: list[CoauthorTranscriptEvent],
    progress: ProgressCallback | None,
    event: CoauthorTranscriptEvent,
) -> None:
    transcript.append(event)
    if progress is not None:
        progress(event)


def associated_markdown_context(path: Path) -> str:
    parts: list[str] = []
    for doc_path in associated_markdown_paths(path):
        if doc_path.exists():
            parts.append(f"# {doc_path.name}\n{doc_path.read_text(encoding='utf-8').strip()}")
    return "\n\n".join(parts) if parts else "No associated markdown context files were found."


def associated_markdown_paths(path: Path) -> list[Path]:
    seen: set[Path] = set()
    ordered: list[Path] = []

    def visit(yaml_path: Path) -> None:
        yaml_path = yaml_path.resolve()
        if yaml_path in seen:
            return
        seen.add(yaml_path)
        raw = yaml_path.read_text(encoding="utf-8")
        import yaml as yaml_module

        loaded = yaml_module.safe_load(raw) or {}
        if isinstance(loaded, dict):
            for import_ref in loaded.get("imports", []) or []:
                if isinstance(import_ref, str):
                    visit((yaml_path.parent / import_ref).resolve())
        ordered.append(yaml_path.with_suffix(".md"))

    visit(path)
    return ordered


def compact_args(args: Any) -> str:
    text = str(args)
    return text if len(text) <= 240 else text[:237] + "..."

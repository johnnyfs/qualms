"""Full-screen prompt_toolkit Application for editor-mode Qualms sessions.

Layout (top → bottom):

    transcript           (content-sized, wraps; auto-scrolls when full)
    ───── (top rule)
    > input              (or "Coauthor running…" placeholder)
    ───── (bottom rule)
    [Mode] metadata
    spacer               (flex; absorbs leftover so the chrome migrates with content)

Story content (banner, intro, room frames, player command echoes) lives on the
unified transcript and is always visible. Coauthor command echoes, tool calls,
streamed agent text, and finish/error status are tagged "author" and only show
when Shift+Tab puts you in coauthor mode.
"""
from __future__ import annotations

import asyncio
import json
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from prompt_toolkit.application import Application
from prompt_toolkit.application.current import get_app
from prompt_toolkit.completion import DynamicCompleter, FuzzyCompleter, WordCompleter
from prompt_toolkit.data_structures import Point
from prompt_toolkit.filters import Condition
from prompt_toolkit.formatted_text import FormattedText
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.layout import (
    ConditionalContainer,
    Float,
    FloatContainer,
    FormattedTextControl,
    HSplit,
    Layout,
    Window,
)
from prompt_toolkit.layout.dimension import Dimension
from prompt_toolkit.layout.menus import CompletionsMenu
from prompt_toolkit.styles import Style
from prompt_toolkit.widgets import TextArea


StyledRun = tuple[str, str]


# --- Banner ---------------------------------------------------------------

LOGO_LINES = [
    "████        ████",
    "  ████████████  ",
    "████  ████  ████",
    "  ████████████  ",
    "██  ████████  ██",
]

INFO_LINES: list[StyledRun] = [
    ("class:title", "Qualms v0.1.0"),
    ("class:subtitle", "Story engine"),
    ("class:subtitle", "Powered by Universal Game Logic Yaml (UGLY)"),
    ("class:subtitle", "2026 johnnygp"),
]

INTRO_TEXT = (
    "Explore with `look`, `examine X`, `take X`, `go X`, `talk to X`, "
    "`inventory`, or `jump X`. Type `quit` to exit. Press Shift+Tab to "
    "switch to coauthor mode and edit the story collaboratively with an "
    "AI; press Shift+Tab again to return to play."
)

COAUTHOR_HINT = (
    "Describe a change you want to make to the story; an AI edits the "
    "model and reports back. Press Shift+Tab to return to play."
)


# --- Style ----------------------------------------------------------------

APP_STYLE = Style.from_dict(
    {
        "logo": "fg:ansibrightblue bold",
        "title": "fg:ansiwhite bold",
        "subtitle": "fg:ansiwhite",
        "intro": "fg:ansiwhite",
        "frame.rule": "fg:ansibrightblack",
        "metadata.tag": "fg:ansibrightcyan bold",
        "metadata.id": "fg:ansiyellow",
        "metadata.name": "fg:ansiwhite",
        "metadata.text": "fg:ansiwhite",
        "echo.play": "fg:ansicyan",
        "echo.author": "fg:ansibrightcyan",
        "agent.label": "fg:ansicyan bold",
        "agent": "fg:ansicyan",
        "tool.call": "fg:ansibrightblack",
        "tool.result": "fg:ansibrightblack",
        "status": "fg:ansibrightblack italic",
        "error": "fg:ansired",
        "story.title": "fg:ansiwhite bold",
        "story": "",
        "busy": "fg:ansiyellow italic",
        "completion-menu.completion": "bg:ansiblack fg:ansiwhite",
        "completion-menu.completion.current": "bg:ansicyan fg:ansiblack bold",
        "completion-menu.meta.completion": "bg:ansiblack fg:ansibrightblack",
        "completion-menu.meta.completion.current": "bg:ansicyan fg:ansiblack",
    }
)


# --- Transcript model ----------------------------------------------------


@dataclass
class TranscriptEntry:
    tag: str  # "play" | "author"
    runs: list[StyledRun] = field(default_factory=list)


@dataclass
class CliAppState:
    entries: list[TranscriptEntry] = field(default_factory=list)
    streaming_entry: TranscriptEntry | None = None
    in_flight: bool = False
    busy_message: str = ""


# --- Run helpers ---------------------------------------------------------


def append_run(runs: list[StyledRun], cls: str, text: str) -> None:
    if not text:
        return
    runs.append((f"class:{cls}", text))


def append_newline(runs: list[StyledRun]) -> None:
    runs.append(("", "\n"))


def make_entry(tag: str) -> TranscriptEntry:
    return TranscriptEntry(tag=tag, runs=[])


def add_entry(state: CliAppState, entry: TranscriptEntry) -> None:
    if entry.runs:
        state.entries.append(entry)


# --- Banner / intro / room frame builders --------------------------------


def banner_entry() -> TranscriptEntry:
    entry = make_entry("play")
    art_gap = "   "
    for index, art_line in enumerate(LOGO_LINES):
        entry.runs.append(("class:logo", art_line))
        if index < len(INFO_LINES):
            entry.runs.append(("", art_gap))
            entry.runs.append(INFO_LINES[index])
        entry.runs.append(("", "\n"))
    append_newline(entry.runs)
    append_run(entry.runs, "intro", INTRO_TEXT)
    append_newline(entry.runs)
    append_newline(entry.runs)
    return entry


def story_frame_entry(lines: list[str]) -> TranscriptEntry | None:
    if not lines:
        return None
    entry = make_entry("play")
    rendered_any = False
    for index, line in enumerate(lines):
        if not line:
            append_newline(entry.runs)
            continue
        if index == 0:
            append_run(entry.runs, "story.title", line)
        else:
            append_run(entry.runs, "story", line)
        append_newline(entry.runs)
        rendered_any = True
    if not rendered_any:
        return None
    append_newline(entry.runs)
    return entry


def player_echo_entry(cmd: str, coauthor: bool) -> TranscriptEntry:
    tag = "author" if coauthor else "play"
    entry = make_entry(tag)
    append_run(entry.runs, "echo.play", "> ")
    append_run(entry.runs, "story", cmd)
    append_newline(entry.runs)
    append_newline(entry.runs)  # blank gap before next content
    return entry


# --- Coauthor event formatting ------------------------------------------


def _format_tool_call(name: str | None, content: str) -> str:
    label = name or "tool"
    return f"* {label}({content})"


def _format_tool_result_lines(
    name: str | None, data: Any, content: str, max_lines: int = 8
) -> list[str]:
    body: str
    if isinstance(data, (dict, list)):
        try:
            body = json.dumps(data, indent=2, ensure_ascii=False)
        except (TypeError, ValueError):
            body = content or str(data)
    elif data is not None:
        body = str(data)
    else:
        body = content or ""
    raw = body.splitlines() or [""]
    if len(raw) > max_lines:
        kept = raw[:max_lines]
        omitted = len(raw) - max_lines
        kept.append(f"   (+{omitted} more lines)")
        raw = kept
    out = [f"  └─ {raw[0]}"]
    for line in raw[1:]:
        out.append(f"     {line}")
    return out


def append_coauthor_event(state: CliAppState, event: Any) -> None:
    """Append a CoauthorTranscriptEvent to the unified transcript as an author entry."""
    kind = getattr(event, "kind", "")
    name = getattr(event, "name", None)
    content = getattr(event, "content", "") or ""
    data = getattr(event, "data", None)

    # The runner echoes the user's prompt as an "agent" event with content prefixed
    # "Request: …". We already echo the prompt ourselves, so drop it.
    if kind == "agent" and content.startswith("Request:"):
        return

    if kind == "agent_delta":
        if state.streaming_entry is None:
            entry = make_entry("author")
            append_run(entry.runs, "agent.label", "Agent: ")
            state.streaming_entry = entry
            state.entries.append(entry)
        append_run(state.streaming_entry.runs, "agent", content)
        return

    if state.streaming_entry is not None:
        append_newline(state.streaming_entry.runs)
        state.streaming_entry = None

    entry = make_entry("author")
    if kind == "status":
        append_run(entry.runs, "status", content)
        append_newline(entry.runs)
    elif kind == "agent":
        append_run(entry.runs, "agent.label", "Agent: ")
        append_run(entry.runs, "agent", content)
        append_newline(entry.runs)
    elif kind == "tool_call":
        append_run(entry.runs, "tool.call", _format_tool_call(name, content))
        append_newline(entry.runs)
    elif kind == "tool_result":
        for line in _format_tool_result_lines(name, data, content):
            append_run(entry.runs, "tool.result", line)
            append_newline(entry.runs)
    elif kind == "error":
        append_run(entry.runs, "error", f"Error: {content}")
        append_newline(entry.runs)
    add_entry(state, entry)


# --- Cursor / scroll helpers --------------------------------------------


def transcript_cursor(runs: list[StyledRun]) -> Point:
    text = "".join(segment for _cls, segment in runs)
    if not text:
        return Point(x=0, y=0)
    lines = text.split("\n")
    return Point(x=len(lines[-1]), y=len(lines) - 1)


# --- Command parsing ----------------------------------------------------


_PROMPT_INLINE_RE = re.compile(r"^\s*prompt(?:\s*:\s*|\s+)(.+)$", re.IGNORECASE | re.DOTALL)


def _inline_coauthor_prompt(command: str) -> str | None:
    match = _PROMPT_INLINE_RE.match(command)
    if not match:
        return None
    return match.group(1).strip()


# --- Entry point ---------------------------------------------------------


@dataclass
class CliAppDeps:
    state: Any
    adventure_screen_lines: Callable[[Any, Any], list[str]]
    append_gameplay_screen: Callable[[Any, list[str]], None]
    append_gameplay_entry: Callable[[Any, str, str], None]
    handle_cli_command: Callable[..., tuple[Any, Any, bool]]
    run_coauthor: Callable[[Path, str, Any, Any], Any]
    reload_world: Callable[[Any, Path, Any], Any]
    coauthor_command_words: Callable[[], list[str]]
    command_words_for_state: Callable[[Any, Any], list[str]]
    normalize_command: Callable[[str], str]
    focus_descriptor: Callable[[Any, Any], tuple[str, str]]


def run_cli_app(
    world: Any,
    data_path: Path,
    editor_enabled: bool,
    deps: CliAppDeps,
) -> None:
    state = deps.state
    state.editor_enabled = editor_enabled
    state.view = "system"

    box: dict[str, Any] = {"world": world}
    app_state = CliAppState()

    # Initial transcript: banner, then first room.
    add_entry(app_state, banner_entry())
    initial_lines = deps.adventure_screen_lines(box["world"], state)
    deps.append_gameplay_screen(state, initial_lines)
    initial_frame = story_frame_entry(initial_lines)
    if initial_frame is not None:
        app_state.entries.append(initial_frame)

    # --- Render callbacks ----

    def visible_runs() -> list[StyledRun]:
        out: list[StyledRun] = []
        coauthor = state.coauthor_mode
        for entry in app_state.entries:
            if entry.tag == "author" and not coauthor:
                continue
            out.extend(entry.runs)
        return out

    def get_transcript() -> FormattedText:
        return FormattedText(visible_runs())

    def get_cursor_position() -> Point:
        return transcript_cursor(visible_runs())

    def get_metadata_text() -> FormattedText:
        if app_state.in_flight:
            return FormattedText(
                [("class:busy", app_state.busy_message or "Coauthor running…")]
            )
        if state.coauthor_mode:
            return FormattedText(
                [
                    ("class:metadata.tag", "[Coauthor mode]"),
                    ("class:metadata.text", " " + COAUTHOR_HINT),
                ]
            )
        focus_id, focus_name = deps.focus_descriptor(box["world"], state)
        return FormattedText(
            [
                ("class:metadata.tag", "[Play mode]"),
                ("class:metadata.text", " "),
                ("class:metadata.id", f"@{focus_id}"),
                ("class:metadata.text", " "),
                ("class:metadata.name", f'"{focus_name}"'),
            ]
        )

    def get_input_prompt() -> FormattedText:
        return FormattedText([("class:echo.play", "> ")])

    def get_completer() -> Any:
        # Don't surface completions for an empty / whitespace input — the popup
        # is noisy at idle, and matches nothing useful anyway.
        if not input_area.text.strip():
            return None
        if state.coauthor_mode:
            words = deps.coauthor_command_words()
        else:
            words = deps.command_words_for_state(box["world"], state)
        unique = sorted({w for w in words if w})
        return FuzzyCompleter(WordCompleter(unique, ignore_case=True))

    # --- Layout ----

    transcript_window = Window(
        content=FormattedTextControl(
            get_transcript,
            focusable=False,
            get_cursor_position=get_cursor_position,
        ),
        wrap_lines=True,
        always_hide_cursor=True,
        dont_extend_height=True,  # content-sized; spacer below absorbs leftover
    )

    metadata_window = Window(
        content=FormattedTextControl(get_metadata_text),
        height=Dimension.exact(1),
    )

    input_area = TextArea(
        height=1,
        multiline=False,
        prompt=get_input_prompt,
        completer=DynamicCompleter(get_completer),
        complete_while_typing=True,
        accept_handler=lambda buffer: _on_submit(buffer.text),
    )

    busy_window = ConditionalContainer(
        content=Window(
            content=FormattedTextControl(
                lambda: FormattedText([("class:busy", "  Coauthor running…")])
            ),
            height=Dimension.exact(1),
        ),
        filter=Condition(lambda: app_state.in_flight),
    )
    input_window = ConditionalContainer(
        content=input_area,
        filter=Condition(lambda: not app_state.in_flight),
    )

    rule_top = Window(height=Dimension.exact(1), char="─", style="class:frame.rule")
    rule_bottom = Window(height=Dimension.exact(1), char="─", style="class:frame.rule")
    spacer = Window(height=Dimension(min=0, weight=1))

    chrome = HSplit(
        [
            rule_top,
            input_window,
            busy_window,
            rule_bottom,
            metadata_window,
        ]
    )

    root = HSplit(
        [
            transcript_window,
            chrome,
            spacer,
        ]
    )

    layout_root = FloatContainer(
        content=root,
        floats=[
            Float(
                xcursor=True,
                ycursor=True,
                content=CompletionsMenu(max_height=10, scroll_offset=1),
            ),
        ],
    )

    # --- Submit + handlers ----

    def _echo_player_command(cmd: str) -> None:
        app_state.entries.append(player_echo_entry(cmd, state.coauthor_mode))

    def _render_play_frame() -> None:
        new_lines = deps.adventure_screen_lines(box["world"], state)
        deps.append_gameplay_screen(state, new_lines)
        frame = story_frame_entry(new_lines)
        if frame is not None:
            app_state.entries.append(frame)

    def _on_submit(text: str) -> bool:
        if app_state.in_flight:
            return False
        cmd = text
        _echo_player_command(cmd)
        try:
            _dispatch(cmd)
        except Exception as error:  # noqa: BLE001
            err_entry = make_entry("author" if state.coauthor_mode else "play")
            append_run(err_entry.runs, "error", f"Error: {error}")
            append_newline(err_entry.runs)
            add_entry(app_state, err_entry)
            get_app().invalidate()
        return False

    def _dispatch(cmd: str) -> None:
        normalized = deps.normalize_command(cmd)
        if normalized in {"quit", "exit"}:
            get_app().exit()
            return

        if state.coauthor_mode:
            if normalized in {"story", "exit coauthor", "exit prompt", "leave coauthor", "/story"}:
                state.coauthor_mode = False
                get_app().invalidate()
                return
            if not cmd.strip():
                return
            _submit_coauthor_turn(cmd)
            return

        # Play mode. Inline "prompt foo" is intercepted so it streams via our
        # threaded progress instead of corrupting the screen via the legacy printer.
        inline_prompt = _inline_coauthor_prompt(cmd)
        if inline_prompt is not None:
            if not inline_prompt:
                return
            state.coauthor_mode = True
            _submit_coauthor_turn(inline_prompt)
            get_app().invalidate()
            return

        deps.append_gameplay_entry(state, "Player", cmd)
        was_coauthor = state.coauthor_mode
        new_world, _new_state, should_quit = deps.handle_cli_command(
            None,  # input_surface — modal prompts not yet wired in app mode
            box["world"],
            data_path,
            editor_enabled,
            state,
            cmd,
        )
        if should_quit:
            get_app().exit()
            return
        box["world"] = new_world
        if not state.coauthor_mode and not was_coauthor:
            _render_play_frame()
        get_app().invalidate()

    def _submit_coauthor_turn(prompt_text: str) -> None:
        loop = asyncio.get_running_loop()
        app_state.in_flight = True
        app_state.busy_message = "Coauthor running…"
        get_app().invalidate()

        def progress(event: Any) -> None:
            loop.call_soon_threadsafe(_on_event, event)

        def _on_event(event: Any) -> None:
            append_coauthor_event(app_state, event)
            get_app().invalidate()

        def worker() -> None:
            try:
                result = deps.run_coauthor(data_path, prompt_text, state, progress)
                loop.call_soon_threadsafe(_finish, result, None)
            except Exception as error:  # noqa: BLE001
                loop.call_soon_threadsafe(_finish, None, error)

        def _finish(result: Any, error: Exception | None) -> None:
            if app_state.streaming_entry is not None:
                append_newline(app_state.streaming_entry.runs)
                app_state.streaming_entry = None
            finish_entry = make_entry("author")
            if error is not None:
                append_run(finish_entry.runs, "error", f"Coauthor error: {error}")
                append_newline(finish_entry.runs)
            elif result is not None:
                output = getattr(result, "output", None)
                if output is not None:
                    summary = getattr(output, "summary", "")
                    if summary:
                        append_run(finish_entry.runs, "status", f"Summary: {summary}")
                        append_newline(finish_entry.runs)
                committed = getattr(result, "committed", False)
                append_run(
                    finish_entry.runs,
                    "status",
                    "Committed." if committed else "No changes committed.",
                )
                append_newline(finish_entry.runs)
                if committed:
                    try:
                        box["world"] = deps.reload_world(box["world"], data_path, state)
                    except (OSError, ValueError, KeyError) as reload_error:
                        append_run(
                            finish_entry.runs,
                            "error",
                            f"Reload failed: {reload_error}",
                        )
                        append_newline(finish_entry.runs)
            append_newline(finish_entry.runs)
            add_entry(app_state, finish_entry)
            if (
                error is None
                and result is not None
                and getattr(result, "committed", False)
            ):
                state.force_cli_location = True
                _render_play_frame()
            app_state.in_flight = False
            app_state.busy_message = ""
            input_area.buffer.reset()
            get_app().invalidate()

        threading.Thread(target=worker, daemon=True).start()

    # --- Key bindings ----

    kb = KeyBindings()

    @kb.add("s-tab")
    def _(event: Any) -> None:
        state.coauthor_mode = not state.coauthor_mode
        event.app.invalidate()

    @kb.add("c-c")
    def _(event: Any) -> None:
        if not app_state.in_flight:
            event.app.exit()

    @kb.add("c-d")
    def _(event: Any) -> None:
        if not app_state.in_flight and not input_area.text:
            event.app.exit()

    layout = Layout(layout_root, focused_element=input_area)
    application = Application(
        layout=layout,
        key_bindings=kb,
        full_screen=True,
        style=APP_STYLE,
        mouse_support=False,
    )
    application.run()

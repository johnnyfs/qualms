# Temporary CLI and Coauthoring Migration Plan

Status: temporary working plan. Remove or replace this once the CLI migration and coauthoring architecture settle.

## Goal

Move the playable/editor interface from a curses box UI toward a classic command prompt adventure UI, then layer AI coauthoring on top of the story hierarchy without coupling coauthoring to normal editor mode.

## Step 1: Prompt CLI Baseline

Status: implemented.

- Keep the current command-driven game state and runtime behavior.
- Render the same display/menu information as plain text each turn.
- Read commands through a prompt loop.
- Use `prompt_toolkit` when available for history, tab completion, and line-editing keys.
- Preserve the old curses UI as a temporary fallback behind `--curses`.
- Keep editor mutations going through the existing story write/reload path.
- Add tests around command alias parsing and screen line rendering.

## Step 2: Command Registry

Status: partially implemented by the prompt command flow.

- Replace ad hoc command aliases with a state-aware command registry.
- Add verbs such as `look`, `go`, `enter`, `examine`, `take`, `talk`, `use`, `board`, `land`, `takeoff`, `jump`, `inventory`, `save`, `restore`, `reload`, and `edit`.
- Make each command declare help text, availability, completion candidates, and dispatch behavior.

## Step 3: State-Aware Completion

Status: partially implemented by visible-target completion.

- Complete currently legal verbs.
- Complete visible destinations, objects, NPCs, ships, inventory items, save paths, and editor targets.
- Prefer stable IDs internally while accepting displayed names at the prompt.

## Step 4: Coauthoring Story Metadata

- Add story-level `coauthoring.md` with style, constraints, and generation guidance.
- Add explicit metadata for incomplete areas.
- Keep coauthoring disabled unless the engine is run with a coauthoring flag.

## Step 5: Agent Integration

- Use Pydantic AI behind a provider abstraction.
- First agent pass should only emit the area it wants to populate.
- Add bounded tools for inspecting story hierarchy, reading local area context, proposing edits, and validating proposed story data.

## Step 6: Blessing Workflow

- If editing and coauthoring are both enabled, mark generated content as unblessed.
- Add editor commands to bless, reject, or give inline feedback on generated content.
- Persist blessed content through the normal story writer path.

## Current Risks

- `curses/dark_qualms_story.py` still contains UI, command dispatch, and editor prompting in one module.
- The prompt CLI has its own command handling, but it is still implemented in the same large module as projection and editor code.
- Dependency management is still minimal and should become a proper package setup before adding provider-specific AI dependencies.

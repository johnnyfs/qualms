# Co-authoring Integration Plan

Status: planned. The prompt CLI is now the maintained playable interface, so this plan covers only the AI co-authoring layer that should sit beside normal play and editing.

## Goal

Add optional AI co-authoring that can inspect a story, identify incomplete authored areas, propose bounded YAML changes, and route accepted changes through the existing editor write and reload path. Co-authoring must remain separate from normal play and should never mutate story files without an explicit author action.

## Non-Goals

- Replacing the prompt CLI, command parser, or rules engine.
- Turning generated content into blessed source automatically.
- Adding provider-specific AI dependencies directly to core runtime modules.
- Letting co-authoring tools bypass schema validation or the normal persistence path.

## Activation

- Keep co-authoring disabled unless the engine is started with an explicit co-authoring flag.
- Require editing to be enabled before any generated proposal can be accepted into story data.
- Keep normal play behavior deterministic when co-authoring is disabled.
- Surface generated proposals as editor-side draft state, not as live runtime state.

## Story Metadata

- Add story-level `coauthoring.md` for voice, style, genre, canon constraints, and generation guidance.
- Mark incomplete or expandable areas with explicit story metadata instead of relying on free-text inference.
- Prefer stable entity IDs, trait IDs, relation IDs, and rule IDs in generated proposals.
- Preserve local authoring conventions from nearby story data when proposing new entities, rules, and text.

## Agent Architecture

- Use Pydantic AI behind a small provider abstraction so model/provider choice stays outside the runtime core.
- Keep the first agent pass narrow: select the area to work on, explain why it is eligible, and request only the context needed for that area.
- Feed the agent read-only projections of the story hierarchy, local area context, relevant prelude definitions, and current validation errors.
- Require proposals to use a structured edit format that can be validated before any file write occurs.

## Tool Surface

Co-authoring tools should be bounded and explicit:

- Inspect the story hierarchy and list incomplete or expandable areas.
- Read local context for one selected area.
- Read the relevant schema, trait, relation, action, and rule definitions.
- Propose additions or replacements as structured story edits.
- Validate proposed story data without persisting it.
- Return validation failures and author feedback to the agent for a revised proposal.

## Proposal Workflow

- Generated content starts as an unblessed proposal.
- The editor can show, reject, revise, or bless a proposal.
- Inline author feedback should produce a new proposal rather than patching files directly.
- Blessed content is persisted through the normal story writer path, then immediately reloaded and validated.
- Rejected proposals should leave no durable story-file changes.

## Validation Requirements

- Validate generated YAML against the same loader and runtime checks used for handwritten story data.
- Keep proposal validation deterministic and path-specific.
- Reject edits that introduce duplicate IDs, broken references, cyclic kind expansion, unsupported trait fields, or invalid rule/action contracts.
- Add focused tests around proposal validation, blessing, rejection, and save/reload behavior before enabling file writes.

## Current Risks

- `curses/dark_qualms_story.py` still contains UI, command dispatch, projection, and editor prompting in one module.
- The prompt CLI is maintained, but co-authoring should not deepen coupling to the large UI/editor module.
- Dependency management is still minimal and should become a proper package setup before adding provider-specific AI dependencies.
- The runtime query layer is intentionally deferred; co-authoring may clarify which supported queries are needed instead of ad hoc scans.

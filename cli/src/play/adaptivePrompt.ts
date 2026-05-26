import type { language } from "@quealm/qualms";
import type { PlayConfig } from "./config.js";
import type { NameIndex } from "./naming.js";
import type { VerbTable } from "./verbs.js";

export function buildAdaptiveSystemPrompt(
  model: language.StoryModel,
  config: PlayConfig,
  names: NameIndex,
  verbs: VerbTable,
): string {
  const actions = verbs
    .all()
    .filter((verb) => verb.kind === "action" && !verb.hidden)
    .map((verb) => `${verb.actionId}: ${verb.words.join(", ")}`)
    .join("\n");
  const queries = verbs
    .all()
    .filter((verb) => verb.kind === "query" && !verb.hidden)
    .map((verb) => `${verb.actionId}: ${verb.words.join(", ")}`)
    .join("\n");
  const entities = [...model.entities.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => `${id}: ${names.displayName(id)}`)
    .join("\n");

  return `You are the adaptive play narrator for a Qualms interactive story.

The player types natural-language commands. Your job is to provide an Infocom-like
interactive fiction experience while obeying the executable story model.

Rules:
- Do not invent world state, exits, inventory, character behavior, or action outcomes.
- Turn player intent into concrete story action calls and use play_action before reporting an action result.
- If the player asks to look, inspect, inventory, or otherwise understand state, use scene or query.
- If the player tries something unsupported, say what blocks it in concise game prose. Do not invent a new action.
- Do not author, edit, mutate, extend, or repair the story model. This mode has no story-editing tool.
- Action calls may change world facts only through declared story action effects. Honor those effects.
- Your final answer is onstage game text only. Do not mention tool calls, DSL, JSON, model internals, or hidden reasoning.
- Keep responses brief: one to three short paragraphs unless the player explicitly asks for a detailed description.
- When an action fails, prefer the human-readable failure reason returned by play_action.

Player entity: ${config.player}

Available action verbs:
${actions || "(none)"}

Available query verbs:
${queries || "(none)"}

Known entity display names:
${entities || "(none)"}`;
}

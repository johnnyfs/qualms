export type AboutMode = "dsl" | "play" | "adaptive" | "coauthor";

export interface AboutLine {
  readonly text: string;
  readonly bold?: boolean;
}

export function buildAboutLines(mode: AboutMode): readonly AboutLine[] {
  const current = (name: AboutMode): string =>
    name === mode ? " (current)" : "";
  return [
    { text: "Qualms v0.1", bold: true },
    { text: "" },
    { text: "An executable, embeddable, agent-friendly story model." },
    { text: "" },
    { text: "What it does", bold: true },
    { text: "" },
    {
      text:
        "Defines what is true in the story world, what actions are allowed, how actions change state, and how tools can query that state.",
    },
    { text: "" },
    { text: "What it is not", bold: true },
    { text: "" },
    {
      text:
        "It is not a game engine, asset manager, or prose layer. It is designed to work with those systems: tracking story state and returning external_ids associated with objects and dialog that the engine maps to localized assets.",
    },
    { text: "" },
    { text: "Supported Workflows", bold: true },
    { text: "" },
    {
      text:
        "• Coauthoring: the designer works with an agent to author a story model in the Qualms DSL, then embeds an engine-native interpreter or server in their simulation.",
    },
    {
      text:
        "• Adaptive play: the designer defines a mapping from the story model to procedurally generated assets and embeds a coauthoring agent which uses the DSL to make changes to the game on the fly.",
    },
    { text: "" },
    { text: "About this CLI", bold: true },
    { text: "" },
    {
      text:
        "It provides tools for authoring, testing, and exporting story models. A tutorial and example story are available. Qualms can also run headless as a service (coming soon) or in an MCP server.",
    },
    { text: "" },
    { text: "Modes:", bold: true },
    { text: "" },
    {
      text: `• DSL mode${current("dsl")} lets you inspect and edit the model directly with formal commands.`,
    },
    {
      text: `• Coauthor mode${current("coauthor")} lets you issue natural-language instructions to an agent that edits the model.`,
    },
    {
      text: `• Play mode${current("play")} lets you test the model through dynamic mockups defined by the story.`,
    },
    {
      text: `• Adaptive mode${current("adaptive")} lets you play through an agent narrator that can inspect and play declared story actions without editing definitions.`,
    },
  ];
}

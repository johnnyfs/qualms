export type AboutMode = "dsl" | "play" | "coauthor";

export function buildAboutLines(mode: AboutMode): readonly string[] {
  const current = (name: AboutMode): string =>
    name === mode ? " (current)" : "";
  return [
    "Qualms is an executable, embeddable story-state model.",
    "",
    "It defines what is true in the story world, what actions are allowed, how actions change state, and how tools can query that state. It is not the final player UI, prose layer, or game engine.",
    "",
    "This CLI provides tools for authoring, testing, and exporting story models. A tutorial and example story are available. Qualms can also run headless as a service (coming soon) or in an MCP server, letting a game engine use it as a story core for live coauthoring or adaptive play.",
    "",
    "Modes:",
    `DSL mode${current("dsl")} lets you inspect and edit the model directly with formal commands.`,
    `Coauthor mode${current("coauthor")} lets you issue natural-language instructions to an agent that edits the model.`,
    `Play mode${current("play")} lets you test the model through dynamic mockups defined by the story.`,
  ];
}

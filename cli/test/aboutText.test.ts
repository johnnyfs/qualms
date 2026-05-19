import { describe, expect, it } from "vitest";
import { buildAboutLines } from "../src/aboutText.js";

describe("buildAboutLines", () => {
  it("marks DSL as current in DSL mode", () => {
    const lines = buildAboutLines("dsl");
    expect(lines).toContain("DSL mode (current) lets you inspect and edit the model directly with formal commands.");
    expect(lines).toContain("Coauthor mode lets you issue natural-language instructions to an agent that edits the model.");
    expect(lines).toContain("Play mode lets you test the model through dynamic mockups defined by the story.");
  });

  it("marks coauthor as current in coauthor mode", () => {
    const lines = buildAboutLines("coauthor");
    expect(lines).toContain("DSL mode lets you inspect and edit the model directly with formal commands.");
    expect(lines).toContain("Coauthor mode (current) lets you issue natural-language instructions to an agent that edits the model.");
  });

  it("marks play as current in play mode", () => {
    const lines = buildAboutLines("play");
    expect(lines).toContain("Play mode (current) lets you test the model through dynamic mockups defined by the story.");
    expect(lines).toContain(
      "This CLI provides tools for authoring, testing, and exporting story models. A tutorial and example story are available. Qualms can also run headless as a service (coming soon) or in an MCP server, letting a game engine use it as a story core for live coauthoring or adaptive play.",
    );
  });
});

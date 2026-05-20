import { describe, expect, it } from "vitest";
import { buildAboutLines } from "../src/aboutText.js";

describe("buildAboutLines", () => {
  it("marks DSL as current in DSL mode", () => {
    const lines = buildAboutLines("dsl");
    expect(lines[0]).toEqual({ text: "Qualms v0.1", bold: true });
    expect(lines).toContainEqual({ text: "What it does", bold: true });
    expect(lines).toContainEqual({
      text: "• DSL mode (current) lets you inspect and edit the model directly with formal commands.",
    });
  });

  it("marks coauthor as current in coauthor mode", () => {
    const lines = buildAboutLines("coauthor");
    expect(lines).toContainEqual({ text: "What it is not", bold: true });
    expect(lines).toContainEqual({
      text: "• Coauthor mode (current) lets you issue natural-language instructions to an agent that edits the model.",
    });
  });

  it("marks play as current in play mode", () => {
    const lines = buildAboutLines("play");
    expect(lines).toContainEqual({ text: "Supported Workflows", bold: true });
    expect(lines).toContainEqual({ text: "About this CLI", bold: true });
    expect(lines).toContainEqual({
      text: "• Play mode (current) lets you test the model through dynamic mockups defined by the story.",
    });
    expect(lines).toContainEqual({
      text: "• Coauthoring: the designer works with an agent to author a story model in the Qualms DSL, then embeds an engine-native interpreter or server in their simulation.",
    });
    expect(lines).toContainEqual({
      text: "• Adaptive play: the designer defines a mapping from the story model to procedurally generated assets and embeds a coauthoring agent which uses the DSL to make changes to the game on the fly.",
    });
  });
});

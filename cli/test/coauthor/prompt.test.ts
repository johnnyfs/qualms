import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../src/coauthor/prompt.js";

describe("coauthor prompt", () => {
  it("lists available skills and when to use them", () => {
    const prompt = buildSystemPrompt();

    expect(prompt).toContain("Skills available:");
    expect(prompt).toContain("story_designer (Story Designer)");
    expect(prompt).toContain("Use when the writer asks you to be creative");
    expect(prompt).toContain('"read_skill": load detailed guidance');
    expect(prompt).toContain('Use "?name" only to introduce a new local binding');
    expect(prompt).toContain('Use bare "name" to reference a parameter or prior binding');
  });
});

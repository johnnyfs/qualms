import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const TUTORIAL_PATH = resolve(__filename, "../../../stories/tutorial/tutorial.qualms");

const {
  LanguageModelError,
  emitProgram,
  idTerm,
  loadStoryProgram,
  parseProgram,
  relationTerm,
} = language;

describe("tutorial language model", () => {
  it("loads tutorial definitions, entities, extensions, and set blocks", () => {
    const source = readFileSync(TUTORIAL_PATH, "utf-8");
    const model = loadStoryProgram(source);

    expect(model.traits.size).toBe(10);
    expect(model.relations.size).toBe(8);
    expect(model.predicates.size).toBe(1);
    expect(model.actions.size).toBe(9);
    expect(model.rules).toHaveLength(11);
    expect(model.entities.size).toBe(10);
    expect(model.listFacts()).toHaveLength(11);

    expect(model.entityTraits("Bars")).toEqual(
      new Set(["Describable", "Locatable", "Openable", "Lockable"]),
    );
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Cell")])).toBe(true);
    expect(model.hasFact("At", [idTerm("Bars"), idTerm("Cell")])).toBe(false);
    expect(
      model.hasFact("Gated", [
        relationTerm("Path", [idTerm("Cell"), idTerm("Corridor")]),
        idTerm("Bars"),
      ]),
    ).toBe(true);
    expect(model.hasFact("Locked", [idTerm("Bars")])).toBe(true);
  });

  it("rejects unknown traits and relations during model load", () => {
    expect(() => loadStoryProgram("entity Rock { Missing }")).toThrowError(LanguageModelError);
    expect(() => loadStoryProgram("trait T\nset { Missing(Rock); }")).toThrowError(
      LanguageModelError,
    );
  });

  it("emits parseable tutorial language", () => {
    const source = readFileSync(TUTORIAL_PATH, "utf-8");
    const program = parseProgram(source);
    const emitted = emitProgram(program);
    const reparsed = parseProgram(emitted);

    expect(reparsed.statements.map((s) => s.kind)).toEqual(
      program.statements.map((s) => s.kind),
    );
  });
});

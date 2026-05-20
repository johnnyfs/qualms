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
  emitStoryModel,
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
    expect(model.relations.size).toBe(13);
    expect(model.predicates.size).toBe(5);
    expect(model.actions.size).toBe(12);
    expect(model.actionCases.map((actionCase) => actionCase.id)).toEqual([]);
    expect(model.rules).toHaveLength(9);
    expect(model.startingMockup).toMatchObject({ relation: "MainMenu" });
    expect(model.validations.size).toBe(1);
    expect(model.entities.size).toBe(20);
    expect(model.entities.has("ActOne.Cell")).toBe(true);
    expect(model.entities.has("Cell")).toBe(false);
    expect(model.listFacts()).toHaveLength(28);
    expect(model.hasFact("TalksAbout", [idTerm("Guard"), idTerm("Bribery")])).toBe(false);
    expect(model.hasFact("TalksAbout", [idTerm("Guard"), idTerm("Whatever")])).toBe(true);

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

  it("resolves unambiguous namespaced entity references", () => {
    const model = loadStoryProgram(`
      trait Location
      relation Path(Location, Location)
      namespace ActOne {
        entity Cell { Location }
        entity Corridor { Location }
      }
      set Path(Cell, Corridor)
    `);

    expect(model.hasFact("Path", [idTerm("ActOne.Cell"), idTerm("ActOne.Corridor")])).toBe(true);
    expect(model.hasFact("Path", [idTerm("Cell"), idTerm("Corridor")])).toBe(true);
  });

  it("resolves set statements inside namespaces against enclosed entities", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Location
      trait Portable
      relation At(Portable, Location)
      relation StartsAt(Actor, Location)

      entity Player { Actor }
      namespace ActOne {
        entity Cell { Location }
        entity BoneShard { Portable }
        set {
          At(BoneShard, Cell);
          StartsAt(Player, Cell);
        }
      }
      namespace ActTwo {
        entity Cell { Location }
      }
    `);

    expect(model.hasFact("At", [idTerm("ActOne.BoneShard"), idTerm("ActOne.Cell")])).toBe(true);
    expect(model.hasFact("StartsAt", [idTerm("Player"), idTerm("ActOne.Cell")])).toBe(true);
  });

  it("requires qualified references when local entity names are ambiguous", () => {
    expect(() => loadStoryProgram(`
      trait Location
      relation Seen(Location)
      namespace ActOne { entity Cell { Location } }
      namespace ActTwo { entity Cell { Location } }
      set Seen(Cell)
    `)).toThrow("ambiguous entity 'Cell' (ActOne.Cell, ActTwo.Cell)");

    const model = loadStoryProgram(`
      trait Location
      relation Seen(Location)
      namespace ActOne { entity Cell { Location } }
      namespace ActTwo { entity Cell { Location } }
      set Seen(ActTwo.Cell)
    `);
    expect(model.hasFact("Seen", [idTerm("ActTwo.Cell")])).toBe(true);
  });

  it("rejects unknown traits and relations during model load", () => {
    expect(() => loadStoryProgram("entity Rock { Missing }")).toThrowError(LanguageModelError);
    expect(() => loadStoryProgram("trait T\nset { Missing(Rock); }")).toThrowError(
      LanguageModelError,
    );
  });

  it("enforces explicit unique relation constraints", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Location
      relation At(subject: Actor, location: Location) unique(subject)
      entity Player { Actor }
      entity Cell { Location }
      entity Outside { Location }
      set {
        At(Player, Cell);
        At(Player, Outside);
      }
    `);

    expect(model.hasFact("At", [idTerm("Player"), idTerm("Cell")])).toBe(false);
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Outside")])).toBe(true);
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

  it("stores, clones, replaces, and emits the explicit mockup start", () => {
    const model = loadStoryProgram(`
      trait Actor
      entity Player { Actor }
      mockup start { MainMenu(Player) }
      mockup start { OtherMenu(Player) }
    `);

    expect(model.startingMockup).toEqual({
      relation: "OtherMenu",
      args: [{ kind: "identifier", id: "Player" }],
    });
    expect(model.clone().startingMockup).toEqual(model.startingMockup);
    expect(emitStoryModel(model)).toContain("mockup start { OtherMenu(Player) }");
  });
});

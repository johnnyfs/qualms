import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const TUTORIAL_PATH = resolve(__filename, "../../../stories/tutorial/tutorial.qualms");

const { LanguageModelError, loadStoryProgram } = language;

describe("semantic model validation", () => {
  it("accepts the tutorial fixture", () => {
    expect(() => loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"))).not.toThrow();
  });

  it("rejects relations whose parameter types are unknown", () => {
    expect(() => loadStoryProgram(`relation Broken(Missing)`)).toThrow(LanguageModelError);
  });

  it("rejects invalid unique relation constraints", () => {
    expect(() =>
      loadStoryProgram(`
        trait Actor
        trait Location
        relation At(subject: Actor, location: Location) unique(target)
      `),
    ).toThrow(LanguageModelError);
  });

  it("rejects facts with the wrong arity", () => {
    expect(() =>
      loadStoryProgram(`
        trait Thing
        relation Seen(Thing)
        entity Widget { Thing }
        set Seen(Widget, Widget)
      `),
    ).toThrow(LanguageModelError);
  });

  it("rejects facts whose arguments do not satisfy declared types", () => {
    expect(() =>
      loadStoryProgram(`
        trait Actor
        trait Location
        relation At(Actor, Location)
        entity Player { Actor }
        entity Bone { Actor }
        set At(Player, Bone)
      `),
    ).toThrow(LanguageModelError);
  });

  it("rejects malformed relation-valued terms", () => {
    expect(() =>
      loadStoryProgram(`
        trait Location
        trait Door
        relation Path(Location, Location)
        relation Gated(Path, Door)
        entity Cell { Location }
        entity Bars { Door }
        set Gated(Path(Cell), Bars)
      `),
    ).toThrow(LanguageModelError);
  });

  it("rejects rules for unknown targets and arity mismatches", () => {
    expect(() =>
      loadStoryProgram(`
        trait Thing
        action Look(target: Thing) { succeed; }
        before Look(target: Thing, extra: Thing) { fail; }
        entity Widget { Thing }
      `),
    ).toThrow(LanguageModelError);

    expect(() =>
      loadStoryProgram(`
        trait Thing
        before Missing(target: Thing) { fail; }
        entity Widget { Thing }
      `),
    ).toThrow(LanguageModelError);
  });

  it("rejects after rules attached to predicates", () => {
    expect(() =>
      loadStoryProgram(`
        trait Thing
        predicate Visible(target: Thing) { succeed; }
        after Visible(target: Thing) { succeed; }
        entity Widget { Thing }
      `),
    ).toThrow(LanguageModelError);
  });
});

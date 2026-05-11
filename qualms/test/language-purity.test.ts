import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const { LanguageModelError, loadStoryProgram } = language;

describe("predicate purity", () => {
  it("rejects set effects inside predicate bodies", () => {
    expect(() =>
      loadStoryProgram(`
        trait Thing
        relation Seen(Thing)
        predicate TouchesState(target: Thing) {
          set Seen(target)
          succeed;
        }
        entity Widget { Thing }
      `),
    ).toThrow(LanguageModelError);
  });

  it("rejects emitted events inside predicate bodies", () => {
    expect(() =>
      loadStoryProgram(`
        trait Thing
        predicate TouchesHost(target: Thing) {
          emit Saw(target);
          succeed;
        }
        entity Widget { Thing }
      `),
    ).toThrow(LanguageModelError);
  });

  it("rejects side effects inside rules attached to known predicates", () => {
    expect(() =>
      loadStoryProgram(`
        trait Thing
        relation Seen(Thing)
        predicate Visible(target: Thing) {
          succeed;
        }
        before Visible(target: Thing) {
          when (!Seen(target)) {
            set Seen(target)
            succeed;
          }
        }
        entity Widget { Thing }
      `),
    ).toThrow(LanguageModelError);
  });

  it("allows action rules to mutate state", () => {
    const model = loadStoryProgram(`
      trait Thing
      relation Seen(Thing)
      action Look(target: Thing) {
        succeed;
      }
      after Look(target: Thing) {
        set Seen(target)
      }
      entity Widget { Thing }
    `);

    expect(model.actions.has("Look")).toBe(true);
    expect(model.rules).toHaveLength(1);
  });
});

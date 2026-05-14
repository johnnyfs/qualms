import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const {
  LanguageModelError,
  LanguageValidationFailedError,
  StoryModel,
  emitProgram,
  parseProgram,
} = language;

function load(source: string): InstanceType<typeof StoryModel> {
  const model = new StoryModel();
  model.apply(parseProgram(source));
  return model;
}

describe("transaction statements", () => {
  it("parses and emits begin, commit, rollback", () => {
    const program = parseProgram("begin; commit; rollback;");
    expect(program.statements.map((s) => s.kind)).toEqual([
      "begin",
      "commit",
      "rollback",
    ]);
    expect(emitProgram(program).trim()).toBe(["begin;", "commit;", "rollback;"].join("\n\n"));
  });

  it("opens and closes a transaction with passing validations", () => {
    const model = load(`
      trait Actor
      trait Locatable
      trait Location

      relation At(subject: Locatable, location: Location) unique(subject)

      entity Player { Actor, Locatable }
      entity Cell { Location }

      set { At(Player, Cell); }
    `);

    expect(model.inTransaction).toBe(false);
    model.apply(parseProgram("begin;"));
    expect(model.inTransaction).toBe(true);
    model.apply(parseProgram("commit;"));
    expect(model.inTransaction).toBe(false);
  });

  it("rejects nested begin", () => {
    const model = load("trait T");
    model.apply(parseProgram("begin;"));
    expect(() => model.apply(parseProgram("begin;"))).toThrow(LanguageModelError);
    // Transaction stays open.
    expect(model.inTransaction).toBe(true);
  });

  it("rejects commit/rollback when no transaction is open", () => {
    const model = load("trait T");
    expect(() => model.apply(parseProgram("commit;"))).toThrow(LanguageModelError);
    expect(() => model.apply(parseProgram("rollback;"))).toThrow(LanguageModelError);
  });

  it("rolls back facts on rollback", () => {
    const model = load(`
      trait Actor
      trait Locatable
      trait Location

      relation At(subject: Locatable, location: Location) unique(subject)

      entity Player { Actor, Locatable }
      entity Cell { Location }
      entity Outside { Location }

      set { At(Player, Cell); }
    `);

    model.apply(parseProgram("begin;"));
    model.apply(parseProgram("set { !At(Player, Cell); At(Player, Outside); }"));
    expect(model.hasFact("At", [{ kind: "id", id: "Player" }, { kind: "id", id: "Outside" }])).toBe(true);
    model.apply(parseProgram("rollback;"));
    expect(model.inTransaction).toBe(false);
    expect(model.hasFact("At", [{ kind: "id", id: "Player" }, { kind: "id", id: "Cell" }])).toBe(true);
    expect(model.hasFact("At", [{ kind: "id", id: "Player" }, { kind: "id", id: "Outside" }])).toBe(false);
  });

  it("does not auto-rollback on commit failure", () => {
    const model = load(`
      trait Actor
      trait Locatable
      trait Location

      relation At(subject: Locatable, location: Location) unique(subject)

      entity Player { Actor, Locatable }
      entity Cell { Location }

      set { At(Player, Cell); }

      validation PlayerInCell {
        assert fact At(Player, Cell);
      }
    `);

    model.apply(parseProgram("begin;"));
    model.apply(parseProgram("set { !At(Player, Cell); }"));

    expect(() => model.apply(parseProgram("commit;"))).toThrow(LanguageValidationFailedError);
    expect(model.inTransaction).toBe(true);
    expect(model.hasFact("At", [{ kind: "id", id: "Player" }, { kind: "id", id: "Cell" }])).toBe(false);

    // Agent fixes the violation, then commits.
    model.apply(parseProgram("set { At(Player, Cell); }"));
    model.apply(parseProgram("commit;"));
    expect(model.inTransaction).toBe(false);
  });

  it("rejects a failing per-call mutate inside a transaction atomically", () => {
    const model = load(`
      trait Actor
      trait Locatable
      trait Location

      relation At(subject: Locatable, location: Location) unique(subject)

      entity Player { Actor, Locatable }
      entity Cell { Location }
      entity Outside { Location }

      set { At(Player, Cell); }
    `);

    model.apply(parseProgram("begin;"));

    // A multi-statement call where the second statement is invalid (unknown entity).
    // The first should NOT remain applied — the call rolls back to its pre-call snapshot,
    // but the transaction stays open.
    expect(() =>
      model.apply(parseProgram("set { At(Player, Outside); } set { At(Player, Nowhere); }")),
    ).toThrow();

    // Tx still open.
    expect(model.inTransaction).toBe(true);
    // The Outside assignment from the first statement was rolled back.
    expect(model.hasFact("At", [{ kind: "id", id: "Player" }, { kind: "id", id: "Outside" }])).toBe(false);
    // Original state intact.
    expect(model.hasFact("At", [{ kind: "id", id: "Player" }, { kind: "id", id: "Cell" }])).toBe(true);
  });

  it("preserves existing apply semantics outside a transaction", () => {
    // Without an open tx, a failing apply does NOT roll back prior statements
    // in the same call. (Existing behavior.)
    const model = load(`
      trait Actor
      trait Locatable
      trait Location

      relation At(subject: Locatable, location: Location)

      entity Player { Actor, Locatable }
      entity Cell { Location }
    `);

    expect(() =>
      model.apply(parseProgram("set { At(Player, Cell); At(Player, Nowhere); }")),
    ).toThrow();

    // The Cell assignment from before the failing one remains.
    expect(model.hasFact("At", [{ kind: "id", id: "Player" }, { kind: "id", id: "Cell" }])).toBe(true);
  });
});

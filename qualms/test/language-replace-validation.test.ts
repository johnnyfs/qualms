import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const { LanguageModelError, StoryModel, emitProgram, parseProgram } = language;

function baseModel(): InstanceType<typeof StoryModel> {
  const model = new StoryModel();
  model.apply(
    parseProgram(`
      trait Actor
      trait Locatable
      trait Location

      relation At(subject: Locatable, location: Location) unique(subject)

      entity Player { Actor, Locatable }
      entity Cell { Location }
      entity Outside { Location }

      set { At(Player, Cell); }

      validation PlayerInCell {
        assert fact At(Player, Cell);
      }
    `),
  );
  return model;
}

describe("replace validation", () => {
  it("parses and emits with replace prefix", () => {
    const program = parseProgram(
      "replace validation PlayerInCell { assert fact At(Player, Outside); }",
    );
    expect(program.statements).toHaveLength(1);
    expect(program.statements[0]).toMatchObject({
      kind: "validation",
      id: "PlayerInCell",
      replace: true,
    });
    expect(emitProgram(program)).toContain("replace validation PlayerInCell");
  });

  it("overrides an existing validation in-place", () => {
    const model = baseModel();
    model.apply(
      parseProgram(`
        replace validation PlayerInCell {
          assert fact At(Player, Outside);
        }
      `),
    );

    expect(model.validations.size).toBe(1);
    const replaced = model.validations.get("PlayerInCell")!;
    expect(replaced.assertions).toHaveLength(1);
    expect(replaced.assertions[0]?.kind).toBe("fact");

    // Now commit should fail against the updated assertion (Player is in Cell, not Outside).
    model.apply(parseProgram("begin;"));
    expect(() => model.apply(parseProgram("commit;"))).toThrow(
      language.LanguageValidationFailedError,
    );
  });

  it("rejects replace when the validation does not exist", () => {
    const model = baseModel();
    expect(() =>
      model.apply(
        parseProgram(
          "replace validation Nope { assert fact At(Player, Cell); }",
        ),
      ),
    ).toThrow(LanguageModelError);
  });

  it("plain validation with the same name still errors as duplicate", () => {
    const model = baseModel();
    expect(() =>
      model.apply(
        parseProgram(
          "validation PlayerInCell { assert fact At(Player, Cell); }",
        ),
      ),
    ).toThrow(LanguageModelError);
  });

  it("can be used inside a transaction to fix a failed commit", () => {
    const model = baseModel();
    // Set up: open tx, move player Outside (violates PlayerInCell).
    model.apply(parseProgram("begin;"));
    model.apply(parseProgram("set { !At(Player, Cell); At(Player, Outside); }"));
    expect(() => model.apply(parseProgram("commit;"))).toThrow(
      language.LanguageValidationFailedError,
    );

    // Coauthor amends the validation rather than the world.
    model.apply(
      parseProgram(`
        replace validation PlayerInCell {
          assert fact At(Player, Outside);
        }
      `),
    );
    model.apply(parseProgram("commit;"));
    expect(model.inTransaction).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const {
  LanguageModelError,
  emitProgram,
  loadStoryProgram,
  parseProgram,
} = language;

const BASE = `
  trait Actor
  entity Player { Actor }
  action Look(actor: Actor) { succeed; }
  action Wait(actor: Actor) { succeed; }
  mockup MainMenu(cursor: Actor) {
    title { "Main" }
    options {
      "look" -> Look(cursor)
    }
  }
`;

describe("replace mockup", () => {
  it("parses and emits replace mockup declarations", () => {
    const program = parseProgram(`
      replace mockup MainMenu(cursor: Actor) {
        title { "Changed" }
        options {
          "wait" -> Wait(cursor)
        }
      }
    `);
    const statement = program.statements[0];
    expect(statement).toMatchObject({
      kind: "mockup",
      id: "MainMenu",
      replace: true,
    });
    expect(emitProgram(program)).toContain("replace mockup MainMenu");
  });

  it("replaces an existing mockup definition", () => {
    const model = loadStoryProgram(`
      ${BASE}
      replace mockup MainMenu(cursor: Actor) {
        title { "Changed" }
        options {
          "wait" -> Wait(cursor)
        }
      }
    `);

    const mockup = model.mockups.get("MainMenu");
    expect(mockup?.title).toEqual([{ kind: "string", value: "Changed" }]);
    expect(mockup?.options).toEqual([
      {
        kind: "static",
        label: "wait",
        targets: [{ relation: "Wait", args: [{ kind: "identifier", id: "cursor" }] }],
      },
    ]);
  });

  it("rejects replace mockup without a prior definition", () => {
    expect(() => loadStoryProgram(`
      trait Actor
      action Wait(actor: Actor) { succeed; }
      replace mockup MainMenu(cursor: Actor) {
        title { "Changed" }
        options {
          "wait" -> Wait(cursor)
        }
      }
    `)).toThrowError(LanguageModelError);
    expect(() => loadStoryProgram(`
      trait Actor
      action Wait(actor: Actor) { succeed; }
      replace mockup MainMenu(cursor: Actor) {
        title { "Changed" }
        options {
          "wait" -> Wait(cursor)
        }
      }
    `)).toThrow("replace mockup 'MainMenu' has no prior definition");
  });

  it("rolls back replace mockup inside transactions", () => {
    const model = loadStoryProgram(BASE);
    model.apply(parseProgram("begin;"));
    model.apply(parseProgram(`
      replace mockup MainMenu(cursor: Actor) {
        title { "Changed" }
        options {
          "wait" -> Wait(cursor)
        }
      }
    `));
    expect(model.mockups.get("MainMenu")?.title).toEqual([
      { kind: "string", value: "Changed" },
    ]);
    model.apply(parseProgram("rollback;"));
    expect(model.mockups.get("MainMenu")?.title).toEqual([
      { kind: "string", value: "Main" },
    ]);
  });
});

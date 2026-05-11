import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const {
  idTerm,
  loadStoryProgram,
  parseProgram,
  playLanguageCall,
  runLanguageValidations,
} = language;

describe("first-class validations", () => {
  it("parses and stores validation declarations", () => {
    const program = parseProgram(`
      validation Smoke {
        assert fact At(Player, Cell);
        assert not query At(Player, Outside);
        assert play Go(Player, Cell) => passed;
      }
    `);

    expect(program.statements).toHaveLength(1);
    expect(program.statements[0]).toMatchObject({
      kind: "validation",
      id: "Smoke",
      assertions: [{ kind: "fact" }, { kind: "query" }, { kind: "play" }],
    });
  });

  it("runs fact, query, and play assertions without mutating the model", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Location
      relation At(Actor, one Location)
      relation Path(Location, Location)
      action Go(actor: Actor { At(actor, ?here) }, target: Location) {
        when (Path(?here, target)) {
          set At(actor, target)
        }
      }
      entity Player { Actor }
      entity Cell { Location }
      entity Outside { Location }
      set {
        At(Player, Cell);
        Path(Cell, Outside);
      }
      validation Smoke {
        assert fact At(Player, Cell);
        assert query At(Player, Cell);
        assert not query At(Player, Outside);
        assert play Go(Player, Outside) => passed;
      }
    `);

    expect(runLanguageValidations(model)).toEqual({ status: "passed", failures: [] });
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Cell")])).toBe(true);
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Outside")])).toBe(false);
  });

  it("reports validation failures", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Location
      relation At(Actor, one Location)
      action Stay(actor: Actor) {
        succeed;
      }
      entity Player { Actor }
      entity Cell { Location }
      validation Broken {
        assert fact At(Player, Cell);
        assert play Stay(Player) => failed;
      }
    `);

    const result = runLanguageValidations(model);
    expect(result.status).toBe("failed");
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]).toMatchObject({ validation: "Broken", assertion: 1 });
  });

  it("does not let play validations commit candidate effects", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Location
      relation At(Actor, one Location)
      action Move(actor: Actor, target: Location) {
        set At(actor, target)
      }
      entity Player { Actor }
      entity Cell { Location }
      entity Outside { Location }
      set At(Player, Cell)
      validation Candidate {
        assert play Move(Player, Outside) => passed;
      }
    `);

    expect(runLanguageValidations(model).status).toBe("passed");
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Cell")])).toBe(true);
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Outside")])).toBe(false);

    expect(playLanguageCall(model, "Move(Player, Outside)").status).toBe("passed");
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Outside")])).toBe(true);
  });

  it("checks expected query bindings, effects, and failure reasons", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Location
      relation At(subject: Actor, location: Location) unique(subject)
      relation Path(Location, Location)
      action Go(actor: Actor { At(actor, ?here) }, target: Location) {
        when (Path(?here, target)) {
          set At(actor, target)
        }
      }
      entity Player { Actor }
      entity Cell { Location }
      entity Outside { Location }
      set {
        At(Player, Cell);
        Path(Cell, Outside);
      }
      validation Contract {
        assert query At(Player, ?where) => bindings { ?where == Cell; };
        assert play Go(Player, Outside) => passed effects { At(Player, Outside); };
        assert play Go(Player, Cell) => failed reasons { !Path(Cell, Cell); };
      }
    `);

    expect(runLanguageValidations(model)).toEqual({ status: "passed", failures: [] });
  });
});

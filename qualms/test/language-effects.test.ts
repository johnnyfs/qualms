import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const TUTORIAL_PATH = resolve(__filename, "../../../stories/tutorial/tutorial.qualms");

const { idTerm, loadStoryProgram, parseProgram, playLanguageCall, StoryModel } = language;

describe("engine-tracked effects", () => {
  it("reports assert and retract effects from a passing action", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    // Stage 9 moved the master key to the guard. Walk the conversation tree
    // so the after-rule transfers it; the intervening calls have their own
    // effects that we don't assert on here — the Unlock set below is the
    // focus.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("passed");
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe("passed");
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, OfferAFavor)").status).toBe("passed");

    const unlock = playLanguageCall(model, "Unlock(Player, Bars, MasterKey)");
    expect(unlock.status).toBe("passed");
    expect(unlock.effects).toEqual([
      { polarity: "retract", fact: { relation: "Locked", args: [idTerm("Bars")] } },
    ]);

    const open = playLanguageCall(model, "Open(Player, Bars)");
    expect(open.status).toBe("passed");
    expect(open.effects).toEqual([
      { polarity: "assert", fact: { relation: "Opened", args: [idTerm("Bars")] } },
    ]);

    const go = playLanguageCall(model, "Go(Player, Corridor)");
    expect(go.status).toBe("passed");
    // `one Location` cardinality on At means the move asserts the new fact;
    // the cardinality enforcement removes the prior row without surfacing as
    // a separate effect (only explicit set/retract statements are tracked).
    expect(go.effects).toContainEqual({
      polarity: "assert",
      fact: { relation: "At", args: [idTerm("Player"), idTerm("Corridor")] },
    });
  });

  it("returns empty effects for a passing action with no mutations", () => {
    const model = loadStoryProgram(`
      trait Locatable
      trait Location
      relation At(Locatable, one Location)
      predicate Here(actor: Locatable, location: Location) {
        when (At(actor, location)) { succeed }
      }
      action Check(actor: Locatable, location: Location) {
        when (Here(actor, location)) {}
      }
      entity Cell { Location }
      entity Player { Locatable }
      set At(Player, Cell);
    `);

    const result = playLanguageCall(model, "Check(Player, Cell)");
    expect(result.status).toBe("passed");
    expect(result.effects).toEqual([]);
  });

  it("returns empty effects when the action fails before any set fires", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));
    const blocked = playLanguageCall(model, "Go(Player, Outside)");
    expect(blocked.status).toBe("failed");
    expect(blocked.effects).toEqual([]);
    expect(blocked.failures).toContainEqual({
      kind: "action_failed",
      message: "!Path(Cell, Outside)",
      callable: "Go",
    });
  });

  it("returns emitted events from passing actions only", () => {
    const model = loadStoryProgram(`
      trait Thing
      relation Allowed(Thing)
      action Touch(target: Thing) {
        emit Touched(target);
        when (Allowed(target)) {
          succeed;
        }
      }
      entity Widget { Thing }
    `);

    const failed = playLanguageCall(model, "Touch(Widget)");
    expect(failed.status).toBe("failed");
    expect(failed.events).toEqual([]);

    model.apply(parseProgram("set Allowed(Widget)"));
    const passed = playLanguageCall(model, "Touch(Widget)");
    expect(passed.status).toBe("passed");
    expect(passed.events).toEqual([{ event: "Touched", args: [idTerm("Widget")] }]);
  });

  it("rolls back action body effects when a later statement fails", () => {
    const model = loadStoryProgram(`
      trait Thing
      relation Marked(Thing)
      relation Allowed(Thing)
      action Mark(target: Thing) {
        set Marked(target)
        when (Allowed(target)) {
          succeed;
        }
      }
      entity Widget { Thing }
    `);

    const failed = playLanguageCall(model, "Mark(Widget)");
    expect(failed.status).toBe("failed");
    expect(failed.effects).toEqual([]);
    expect(model.hasFact("Marked", [idTerm("Widget")])).toBe(false);
  });

  it("rolls back action body effects when an after rule fails", () => {
    const model = loadStoryProgram(`
      trait Thing
      relation Marked(Thing)
      relation Blocked(Thing)
      action Mark(target: Thing) {
        set Marked(target)
      }
      after Mark(target: Thing) {
        when (!Blocked(target)) {
          fail;
        }
      }
      entity Widget { Thing }
    `);

    const failed = playLanguageCall(model, "Mark(Widget)");
    expect(failed.status).toBe("failed");
    expect(failed.effects).toEqual([]);
    expect(model.hasFact("Marked", [idTerm("Widget")])).toBe(false);
  });

  it("model.apply returns set/retract effects from a program", () => {
    const model = new StoryModel();
    model.apply(parseProgram(`
      trait Actor
      relation Knows(Actor, Actor)
      entity Alice { Actor }
      entity Bob { Actor }
    `));

    const effects = model.apply(parseProgram(`
      set {
        Knows(Alice, Bob);
        Knows(Bob, Alice);
      }
    `));

    expect(effects).toEqual([
      { polarity: "assert", fact: { relation: "Knows", args: [idTerm("Alice"), idTerm("Bob")] } },
      { polarity: "assert", fact: { relation: "Knows", args: [idTerm("Bob"), idTerm("Alice")] } },
    ]);

    const retracts = model.apply(parseProgram(`set { !Knows(Alice, Bob); }`));
    expect(retracts).toEqual([
      { polarity: "retract", fact: { relation: "Knows", args: [idTerm("Alice"), idTerm("Bob")] } },
    ]);
  });

  it("model.apply returns empty effects for definition-only programs", () => {
    const model = new StoryModel();
    const effects = model.apply(parseProgram(`
      trait Thing
      entity Widget { Thing }
    `));
    expect(effects).toEqual([]);
  });
});

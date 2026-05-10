import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const TUTORIAL_PATH = resolve(__filename, "../../specs/tutorial.qualms");

const { idTerm, loadStoryProgram, playLanguageCall } = language;

describe("tutorial language runtime", () => {
  it("runs minimal movement with compact failure feedback", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Locatable
      trait Location

      relation At(Locatable, one Location)
      relation Path(Location, Location)

      action Go(actor: (Actor & Locatable) { At(actor, here) }, target: Location) {
        when (Path(here, target)) {
          set At(actor, target)
        }
      }

      entity Cell { Location }
      entity Corridor { Location }
      entity Outside { Location }
      entity Player { Actor, Locatable }

      set {
        Path(Cell, Corridor);
        Path(Corridor, Outside);
        At(Player, Cell);
      }
    `);

    const blocked = playLanguageCall(model, "Go(Player, Outside)");
    expect(blocked).toMatchObject({
      status: "failed",
      feedback: "fail { !Path(Cell, Outside); }",
    });

    expect(playLanguageCall(model, "Go(Player, Corridor)").status).toBe("passed");
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Cell")])).toBe(false);
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Corridor")])).toBe(true);

    expect(playLanguageCall(model, "Go(Player, Outside)").status).toBe("passed");
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Outside")])).toBe(true);
  });

  it("runs tutorial doors and locks through predicates and before rules", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    const locked = playLanguageCall(model, "Open(Player, Bars)");
    expect(locked).toMatchObject({
      status: "failed",
      feedback: "fail { Locked(Bars); }",
    });

    const wrongKey = playLanguageCall(model, "Unlock(Player, Bars, MakeshiftKey)");
    expect(wrongKey).toMatchObject({
      status: "failed",
      feedback: "fail { !LockedWith(Bars, MakeshiftKey); }",
    });

    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)").status).toBe("passed");
    expect(model.hasFact("Locked", [idTerm("Bars")])).toBe(false);

    expect(playLanguageCall(model, "Open(Player, Bars)").status).toBe("passed");
    expect(model.hasFact("Opened", [idTerm("Bars")])).toBe(true);

    expect(playLanguageCall(model, "Go(Player, Corridor)").status).toBe("passed");
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Corridor")])).toBe(true);
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Cell")])).toBe(false);
  });
});

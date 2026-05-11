import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const TUTORIAL_PATH = resolve(__filename, "../../../stories/tutorial/tutorial.qualms");

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

  it("runs TalkAbout against a guard visible through the transparent bars", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    // Player starts in the Cell, Guard is in the Corridor, Bars are locked.
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Cell")])).toBe(true);
    expect(model.hasFact("At", [idTerm("Guard"), idTerm("Corridor")])).toBe(true);
    expect(model.hasFact("Locked", [idTerm("Bars")])).toBe(true);

    // Through the bars: IsVisibleTo passes because Bars are transparent and
    // the Cell↔Corridor path conveys visibility; Guard knows about Bribery.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe("passed");

    // Wrong topic: visibility still holds, but the body fails because
    // !TalksAbout(Guard, Checkers).
    const wrongTopic = playLanguageCall(model, "TalkAbout(Player, Guard, Checkers)");
    expect(wrongTopic).toMatchObject({
      status: "failed",
      feedback: "fail { !TalksAbout(Guard, Checkers); }",
    });

    // Walk the Player into the Corridor: colocation now holds directly via
    // IsVisibleTo's IsColocated branch.
    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)").status).toBe("passed");
    expect(playLanguageCall(model, "Open(Player, Bars)").status).toBe("passed");
    expect(playLanguageCall(model, "Go(Player, Corridor)").status).toBe("passed");
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Corridor")])).toBe(true);
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe("passed");

    // Move the Player to the Outside: no ConveysVisibility(Path(Outside, ...)),
    // so IsVisibleTo fails and TalkAbout fails with it.
    expect(playLanguageCall(model, "Go(Player, Outside)").status).toBe("passed");
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Outside")])).toBe(true);
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe("failed");
  });

  it("section 1 — Go fails with !Path when there is no adjacency", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));
    expect(playLanguageCall(model, "Go(Player, Outside)")).toMatchObject({
      status: "failed",
      feedback: "fail { !Path(Cell, Outside); }",
    });
  });

  it("section 2 — Examine succeeds when colocated and fails when out of reach", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    // Examining your own location: IsVisibleTo's At(actor, target) branch.
    expect(playLanguageCall(model, "Examine(Player, Cell)").status).toBe("passed");
    // Examining the bars (through the section-4 IsColocated gate rule).
    expect(playLanguageCall(model, "Examine(Player, Bars)").status).toBe("passed");
    // Examining a remote location: not colocated, not visible.
    expect(playLanguageCall(model, "Examine(Player, Outside)").status).toBe("failed");
  });

  it("section 3 — Take and Drop move portables through Carrying and At", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    // Bars aren't Portable — parameter binding rejects them.
    const notPortable = playLanguageCall(model, "Take(Player, Bars)");
    expect(notPortable.status).toBe("failed");

    // Take a portable from the Player's current location.
    expect(playLanguageCall(model, "Take(Player, BoneShard)").status).toBe("passed");
    expect(model.hasFact("Carrying", [idTerm("Player"), idTerm("BoneShard")])).toBe(true);
    expect(model.hasFact("At", [idTerm("BoneShard"), idTerm("Cell")])).toBe(false);

    // Drop returns it to the actor's location.
    expect(playLanguageCall(model, "Drop(Player, BoneShard)").status).toBe("passed");
    expect(model.hasFact("Carrying", [idTerm("Player"), idTerm("BoneShard")])).toBe(false);
    expect(model.hasFact("At", [idTerm("BoneShard"), idTerm("Cell")])).toBe(true);
  });

  it("section 4 — doors block Go while closed and let it through once opened", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    // Bars start closed (and locked), so Go through them fails.
    const blocked = playLanguageCall(model, "Go(Player, Corridor)");
    expect(blocked.status).toBe("failed");
    expect(blocked.reasons).toContain("!Opened(Bars)");

    // Open already-open Bars should fail with `Opened(Bars)`.
    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)").status).toBe("passed");
    expect(playLanguageCall(model, "Open(Player, Bars)").status).toBe("passed");
    expect(playLanguageCall(model, "Open(Player, Bars)")).toMatchObject({
      status: "failed",
      feedback: "fail { Opened(Bars); }",
    });

    // Closing then re-opening cycles cleanly.
    expect(playLanguageCall(model, "Close(Player, Bars)").status).toBe("passed");
    expect(model.hasFact("Opened", [idTerm("Bars")])).toBe(false);
    expect(playLanguageCall(model, "Open(Player, Bars)").status).toBe("passed");
  });

  it("section 5 — lock cycle: Unlock-when-unlocked and Lock-when-locked both fail", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)").status).toBe("passed");
    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)")).toMatchObject({
      status: "failed",
      feedback: "fail { !Locked(Bars); }",
    });

    expect(playLanguageCall(model, "Lock(Player, Bars, MasterKey)").status).toBe("passed");
    expect(model.hasFact("Locked", [idTerm("Bars")])).toBe(true);
    expect(playLanguageCall(model, "Lock(Player, Bars, MasterKey)")).toMatchObject({
      status: "failed",
      feedback: "fail { Locked(Bars); }",
    });
  });

  it("section 6 — visibility crosses transparent gates and is blocked by opaque ones", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    // From the Cell, Player sees Guard in the Corridor through transparent Bars.
    expect(playLanguageCall(model, "Examine(Player, Guard)").status).toBe("passed");

    // Walk through to the Corridor and try to see the Mop in the Closet —
    // ClosetDoor is opaque and closed, so visibility fails.
    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)").status).toBe("passed");
    expect(playLanguageCall(model, "Open(Player, Bars)").status).toBe("passed");
    expect(playLanguageCall(model, "Go(Player, Corridor)").status).toBe("passed");

    const blocked = playLanguageCall(model, "Examine(Player, Mop)");
    expect(blocked.status).toBe("failed");
    // The failure chain should surface the visibility before-rule's failed
    // when-condition — i.e. that the path is gated by an opaque closed door.
    expect(blocked.reasons.some((r) => r.includes("Gated") && r.includes("Opaque"))).toBe(true);

    // Opening the ClosetDoor restores visibility: Opaque(ClosetDoor) becomes
    // false, the `!(Gated & Opaque)` clause holds, IsVisibleTo passes.
    expect(playLanguageCall(model, "Open(Player, ClosetDoor)").status).toBe("passed");
    expect(playLanguageCall(model, "Examine(Player, Mop)").status).toBe("passed");
  });
});

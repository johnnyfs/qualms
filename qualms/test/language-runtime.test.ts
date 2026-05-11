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
    // the Cell↔Corridor path conveys visibility; Guard knows about Whatever.
    // (Section 8 retracts TalksAbout(Guard, Bribery) and makes Whatever the
    // top-level entry topic — see the conversation-tree test below.)
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("passed");

    // Wrong topic: visibility still holds, but neither (7) nor (8) accept
    // Checkers — the (7) body fails because !TalksAbout(Guard, Checkers),
    // and the (8) before-rule's pass-when fails because !LeadsTo(Guard,
    // Whatever, Checkers), so both reasons surface in the failure chain.
    const wrongTopic = playLanguageCall(model, "TalkAbout(Player, Guard, Checkers)");
    expect(wrongTopic.status).toBe("failed");
    expect(wrongTopic.reasons).toContain("!TalksAbout(Guard, Checkers)");
    expect(wrongTopic.reasons).toContain("!LeadsTo(Guard, Whatever, Checkers)");

    // Walk the Player into the Corridor: colocation now holds directly via
    // IsVisibleTo's IsColocated branch.
    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)").status).toBe("passed");
    expect(playLanguageCall(model, "Open(Player, Bars)").status).toBe("passed");
    expect(playLanguageCall(model, "Go(Player, Corridor)").status).toBe("passed");
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Corridor")])).toBe(true);
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("passed");

    // Move the Player to the Outside: no ConveysVisibility(Path(Outside, ...)),
    // so IsVisibleTo fails and TalkAbout fails with it.
    expect(playLanguageCall(model, "Go(Player, Outside)").status).toBe("passed");
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Outside")])).toBe(true);
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("failed");
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

  it("section 8 — TalkAbout walks a conversation tree gated by InConversation", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    // Sub-topic with no InConversation: the (8) before-rule's speaker
    // constraint fails (no InConversation fact to bind `topic`), the rule
    // doesn't fire, and the (7) action body fails on !TalksAbout.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)")).toMatchObject({
      status: "failed",
      feedback: "fail { !TalksAbout(Guard, Bribery); }",
    });

    // Top-level entry: TalksAbout(Guard, Whatever) holds; the (7) body
    // passes; the (8) after-rule records the new conversation.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("passed");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("Whatever")]),
    ).toBe(true);

    // Walk to a sub-topic: (8) before-rule binds topic=Whatever via the
    // speaker constraint, the body's LeadsTo check passes, and the inline
    // set + `one Topic` cardinality displaces Whatever with Bribery.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe("passed");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("Whatever")]),
    ).toBe(false);
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("Bribery")]),
    ).toBe(true);

    // Step one more level deep.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, OfferMoney)").status).toBe("passed");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("OfferMoney")]),
    ).toBe(true);

    // Off-tree from the current topic: no LeadsTo(Guard, OfferMoney, Weather)
    // and Weather isn't top-level either, so the call fails.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Weather)").status).toBe("failed");

    // Returning to a top-level topic falls through (7) and the after-rule
    // resets InConversation, with `one Topic` retracting the OfferMoney row.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("passed");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("Whatever")]),
    ).toBe(true);
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("OfferMoney")]),
    ).toBe(false);

    // StopTalking clears whatever current InConversation is in scope.
    expect(playLanguageCall(model, "StopTalking(Player, Guard)").status).toBe("passed");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("Whatever")]),
    ).toBe(false);

    // After Stop, a sub-topic call once again fails the (7) body.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe("failed");

    // Geographic gate is preserved: walk to Outside, lose IsVisibleTo, and
    // even a top-level Whatever fails — the (8) rule didn't override the
    // visibility precondition the (7) body relies on. Re-enter via Whatever
    // and a sub-topic so InConversation is set during the walkout.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("passed");
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe("passed");
    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)").status).toBe("passed");
    expect(playLanguageCall(model, "Open(Player, Bars)").status).toBe("passed");
    expect(playLanguageCall(model, "Go(Player, Corridor)").status).toBe("passed");
    expect(playLanguageCall(model, "Go(Player, Outside)").status).toBe("passed");
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, OfferMoney)").status).toBe("failed");
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("failed");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const TUTORIAL_PATH = resolve(__filename, "../../../stories/tutorial/tutorial.qualms");

const { idTerm, loadStoryProgram, playLanguageCall } = language;

// Stage 9 moves the master key from the cell floor onto the guard. To run
// any test that needs the key, the player has to walk Whatever → Bribery →
// OfferAFavor; the after-rule then transfers Carrying(MasterKey).
function walkConversationToMasterKey(model: ReturnType<typeof loadStoryProgram>): void {
  expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("passed");
  expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe("passed");
  expect(playLanguageCall(model, "TalkAbout(Player, Guard, OfferAFavor)").status).toBe("passed");
}

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

    // Without carrying any key, Unlock fails on the !Carrying clause first.
    const noKey = playLanguageCall(model, "Unlock(Player, Bars, MakeshiftKey)");
    expect(noKey).toMatchObject({
      status: "failed",
      feedback: "fail { !Carrying(Player, MakeshiftKey); }",
    });

    // The master key sits with the guard in stage 9; walk the conversation
    // to receive it. The makeshift key is never placed in the world, so
    // attempting to use it still surfaces the same !Carrying reason.
    walkConversationToMasterKey(model);
    const wrongKey = playLanguageCall(model, "Unlock(Player, Bars, MakeshiftKey)");
    expect(wrongKey).toMatchObject({
      status: "failed",
      feedback: "fail { !Carrying(Player, MakeshiftKey); }",
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
    // IsVisibleTo's IsColocated branch. The conversation walk both
    // demonstrates section 8's tree and (via stage 9's after-rule) hands
    // the master key over so Unlock can succeed.
    walkConversationToMasterKey(model);
    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)").status).toBe("passed");
    expect(playLanguageCall(model, "Open(Player, Bars)").status).toBe("passed");
    expect(playLanguageCall(model, "Go(Player, Corridor)").status).toBe("passed");
    expect(model.hasFact("At", [idTerm("Player"), idTerm("Corridor")])).toBe(true);
    // After moving to the corridor, the player is colocated with the guard
    // and a new top-level conversation starts (after-rule resets the topic).
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
    walkConversationToMasterKey(model);
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

    // Unlock requires the actor to be carrying the key. Stage 9 puts the
    // master key with the guard, so until the player walks the conversation
    // to receive it, Unlock fails.
    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)")).toMatchObject({
      status: "failed",
      feedback: "fail { !Carrying(Player, MasterKey); }",
    });

    walkConversationToMasterKey(model);
    expect(model.hasFact("Carrying", [idTerm("Player"), idTerm("MasterKey")])).toBe(true);
    expect(model.hasFact("Carrying", [idTerm("Guard"), idTerm("MasterKey")])).toBe(false);

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

    // Dropping the master key revokes the carry condition: Unlock fails again
    // even though the actor is still in the cell.
    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)").status).toBe("passed");
    expect(playLanguageCall(model, "Drop(Player, MasterKey)").status).toBe("passed");
    expect(playLanguageCall(model, "Lock(Player, Bars, MasterKey)")).toMatchObject({
      status: "failed",
      feedback: "fail { !Carrying(Player, MasterKey); }",
    });
  });

  it("section 6 — visibility crosses transparent gates and is blocked by opaque ones", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    // From the Cell, Player sees Guard in the Corridor through transparent Bars.
    expect(playLanguageCall(model, "Examine(Player, Guard)").status).toBe("passed");

    // Walk through to the Corridor and try to see the Mop in the Closet —
    // ClosetDoor is opaque and closed, so visibility fails.
    walkConversationToMasterKey(model);
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

    // Step one more level deep. Stage 9 attaches an after-rule to OfferMoney
    // that fails when the actor isn't carrying Money. Because actions are
    // atomic, the conversation update is rolled back and the player stays at
    // Bribery.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, OfferMoney)").status).toBe("failed");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("OfferMoney")]),
    ).toBe(false);
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("Bribery")]),
    ).toBe(true);

    // From Bribery, the actor can still walk to OfferAFavor — and stage 9's
    // after-rule hands them the master key.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, OfferAFavor)").status).toBe("passed");
    expect(model.hasFact("Carrying", [idTerm("Player"), idTerm("MasterKey")])).toBe(true);
    expect(model.hasFact("Carrying", [idTerm("Guard"), idTerm("MasterKey")])).toBe(false);

    // Off-tree from the current topic: no LeadsTo(Guard, OfferAFavor, Weather)
    // and Weather isn't top-level either, so the call fails.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Weather)").status).toBe("failed");

    // Returning to a top-level topic falls through (7) and the after-rule
    // resets InConversation, with `one Topic` retracting the OfferAFavor row.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("passed");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("Whatever")]),
    ).toBe(true);
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("OfferAFavor")]),
    ).toBe(false);

    // StopTalking clears whatever current InConversation is in scope.
    expect(playLanguageCall(model, "StopTalking(Player, Guard)").status).toBe("passed");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("Whatever")]),
    ).toBe(false);

    // After Stop, a sub-topic call once again fails the (7) body.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe("failed");

    // Geographic gate is preserved: walk through to Outside, lose
    // IsVisibleTo, and even a top-level Whatever fails — the (8) rule didn't
    // override the visibility precondition the (7) body relies on. Walk the
    // conversation tree to receive the master key, then unlock and exit.
    walkConversationToMasterKey(model);
    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)").status).toBe("passed");
    expect(playLanguageCall(model, "Open(Player, Bars)").status).toBe("passed");
    expect(playLanguageCall(model, "Go(Player, Corridor)").status).toBe("passed");
    expect(playLanguageCall(model, "Go(Player, Outside)").status).toBe("passed");
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, OfferMoney)").status).toBe("failed");
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("failed");
  });

  it("before-rule env is isolated from the action's parameter bindings", () => {
    // Demonstrates the fix: a before-rule can reuse a name from the action
    // ("topic") as a fresh constraint variable, because the action's parameter
    // bindings do not leak into the rule's env. The rule binds `topic`
    // via the speaker constraint's InConversation fact lookup, then walks
    // LeadsTo to the call-site sub-topic.
    const model = loadStoryProgram(`
      trait Actor
      trait Speaker
      trait Topic

      relation TalksAbout(Speaker, Topic)
      relation InConversation(Actor, Speaker, one Topic)
      relation LeadsTo(Speaker, Topic, Topic)

      action TalkAbout(actor: Actor, speaker: Speaker, topic: Topic) {
        when (TalksAbout(speaker, topic)) { succeed; }
      }

      -- Rule reuses the action's parameter name "topic" inside the speaker's
      -- constraint as a fresh variable bound by the InConversation fact.
      -- Without env isolation, the action's "topic" (= call-site sub-topic)
      -- would leak in and force the fact lookup to match the sub-topic
      -- instead of the parent.
      before TalkAbout(
        actor: Actor,
        speaker: Speaker { InConversation(actor, speaker, topic) },
        subTopic: Topic
      ) {
        when (LeadsTo(speaker, topic, subTopic)) {
          set InConversation(actor, speaker, subTopic);
          succeed;
        }
      }

      after TalkAbout(actor: Actor, speaker: Speaker, topic: Topic) {
        set InConversation(actor, speaker, topic);
      }

      entity Player { Actor }
      entity Guard { Speaker }
      entity Whatever { Topic }
      entity Bribery { Topic }
      entity OfferMoney { Topic }

      set {
        TalksAbout(Guard, Whatever);
        LeadsTo(Guard, Whatever, Bribery);
        LeadsTo(Guard, Bribery, OfferMoney);
      }
    `);

    // Top-level: passes via the action body; after-rule records Whatever.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("passed");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("Whatever")]),
    ).toBe(true);

    // Sub-topic walk: the before-rule's `topic` constraint variable must bind
    // to the parent topic Whatever (not the call-site sub-topic Bribery).
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe("passed");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("Bribery")]),
    ).toBe(true);

    // Step further: `topic` rebinds to Bribery (the new parent) on this call.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, OfferMoney)").status).toBe("passed");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("OfferMoney")]),
    ).toBe(true);
  });

  it("section 8 — OfferAFavor needs the player to walk Whatever → Bribery first", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    // No conversation yet: OfferAFavor isn't top-level and there's no
    // current topic to lead from, so WillTalkAbout fails.
    const cold = playLanguageCall(model, "TalkAbout(Player, Guard, OfferAFavor)");
    expect(cold.status).toBe("failed");
    expect(cold.reasons).toContain("!TalksAbout(Guard, OfferAFavor)");

    // Top-level entry establishes Whatever as the current topic.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("passed");

    // From Whatever, OfferAFavor is still two steps deep (Whatever → Bribery
    // → OfferAFavor). LeadsTo(Guard, Whatever, OfferAFavor) doesn't hold.
    const tooFar = playLanguageCall(model, "TalkAbout(Player, Guard, OfferAFavor)");
    expect(tooFar.status).toBe("failed");
    expect(tooFar.reasons).toContain("!LeadsTo(Guard, Whatever, OfferAFavor)");

    // Step to Bribery: now LeadsTo(Guard, Bribery, OfferAFavor) holds.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe("passed");
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, OfferAFavor)").status).toBe("passed");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("OfferAFavor")]),
    ).toBe(true);
  });

  it("section 9 — reactions: OfferMoney rejects, OfferAFavor hands over the master key", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    // The guard starts carrying the master key; the player does not.
    expect(model.hasFact("Carrying", [idTerm("Guard"), idTerm("MasterKey")])).toBe(true);
    expect(model.hasFact("Carrying", [idTerm("Player"), idTerm("MasterKey")])).toBe(false);

    // Unlock fails up front because the player isn't carrying anything.
    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)")).toMatchObject({
      status: "failed",
      feedback: "fail { !Carrying(Player, MasterKey); }",
    });

    // Walk to the OfferMoney leaf: action body passes, but the failing
    // after-rule rolls back the whole action, so InConversation does not
    // advance past Bribery.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Whatever)").status).toBe("passed");
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe("passed");
    const moneyOffer = playLanguageCall(model, "TalkAbout(Player, Guard, OfferMoney)");
    expect(moneyOffer.status).toBe("failed");
    expect(moneyOffer.reasons).toContain("!Carrying(Player, Money)");
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("Bribery")]),
    ).toBe(true);
    expect(
      model.hasFact("InConversation", [idTerm("Player"), idTerm("Guard"), idTerm("OfferMoney")]),
    ).toBe(false);

    // From Bribery, OfferAFavor succeeds and the after-rule transfers the key.
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, OfferAFavor)").status).toBe("passed");
    expect(model.hasFact("Carrying", [idTerm("Player"), idTerm("MasterKey")])).toBe(true);
    expect(model.hasFact("Carrying", [idTerm("Guard"), idTerm("MasterKey")])).toBe(false);

    // Now Unlock + Open + Go all succeed.
    expect(playLanguageCall(model, "Unlock(Player, Bars, MasterKey)").status).toBe("passed");
    expect(playLanguageCall(model, "Open(Player, Bars)").status).toBe("passed");
    expect(playLanguageCall(model, "Go(Player, Corridor)").status).toBe("passed");
  });

  it("entity-literal parameter sugar binds only when the arg matches the entity", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Target

      relation Hit(Actor, Target)

      entity Alice { Actor }
      entity Bob { Target }
      entity Carol { Target }

      action Punch(a: Actor, t: Target) { succeed; }

      -- Sugar: bare 'Bob' in the second slot is desugared to '_: Bob' and
      -- only fires for the entity Bob.
      after Punch(a: Actor, Bob) {
        when (a == Alice) { fail; }
      }
    `);

    // Alice punching Bob: the after-rule binds (Bob slot matches), when
    // (a==Alice) holds, action fails.
    expect(playLanguageCall(model, "Punch(Alice, Bob)").status).toBe("failed");
    // Alice punching Carol: the after-rule's parameter constraint fails to
    // bind (Carol != Bob), so the rule doesn't fire.
    expect(playLanguageCall(model, "Punch(Alice, Carol)").status).toBe("passed");
  });

  it("bare trait/Any parameter sugar binds untyped wildcard against a trait", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Item

      relation Holds(Actor, Item)

      action Try(a: Actor, t: Item) { succeed; }

      -- Sugar: bare 'Item' in the second slot desugars to '_: Item'.
      after Try(Actor, Item) {
        fail;
      }

      entity Player { Actor }
      entity Trinket { Item }

      set {
        Holds(Player, Trinket);
      }
    `);

    // Both args match their bare type slots, so the after-rule fires and the action fails.
    expect(playLanguageCall(model, "Try(Player, Trinket)").status).toBe("failed");
  });

  it("after rule can fail after a successful action body and roll it back", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Item

      relation Holds(Actor, Item)
      relation Marked(Item)

      action Try(a: Actor, t: Item) {
        when (Holds(a, t)) { succeed; }
      }

      after Try(a: Actor, t: Item) {
        when (!Marked(t)) { fail; }
      }

      entity Player { Actor }
      entity Trinket { Item }

      set {
        Holds(Player, Trinket);
      }
    `);

    // Action body would pass (Holds), but the after-rule fires after and
    // fails because Trinket isn't Marked.
    const blocked = playLanguageCall(model, "Try(Player, Trinket)");
    expect(blocked.status).toBe("failed");

    // Mark the trinket; now the after-rule's when no longer matches, so the
    // rule doesn't fire and the action passes through.
    model.assertFact({ relation: "Marked", args: [idTerm("Trinket")] });
    expect(playLanguageCall(model, "Try(Player, Trinket)").status).toBe("passed");
  });

  it("predicate before-rule env is isolated from the enclosing action's parameter bindings", () => {
    // The outer action binds `a` to Player; the predicate it calls binds its
    // own `a` to the same value (since args flow through positionally). But
    // the predicate's before-rule uses a fresh name `a` in a parameter
    // constraint that must bind from a fact lookup — if the action's `a`
    // leaked into the rule's scope, the constraint would silently match the
    // action's actor instead of the fact's actor.
    const model = loadStoryProgram(`
      trait Actor
      trait Tag

      relation Marks(Actor, Tag)

      predicate IsMarked(target: Tag) {
        when (Marks(_, target)) { succeed; }
      }

      -- The rule's a constraint variable must bind freshly from the Marks
      -- fact, not inherit Player from the enclosing action.
      before IsMarked(t: Tag { Marks(a, t) }) {
        when (a == Witness) { succeed; }
      }

      action Probe(a: Actor, t: Tag) {
        when (IsMarked(t)) { succeed; }
      }

      entity Player { Actor }
      entity Witness { Actor }
      entity Mystery { Tag }

      set {
        Marks(Witness, Mystery);
      }
    `);

    // Player is not the marker — but the rule's `a` must still bind to
    // Witness from the Marks fact, not be pinned to Player by leakage.
    expect(playLanguageCall(model, "Probe(Player, Mystery)").status).toBe("passed");
  });

  it("after-rule env is isolated from the action body's env", () => {
    // The action body binds a local name `secret` via its when-clause; the
    // after-rule must not see `secret` and must rebind from its own params.
    const model = loadStoryProgram(`
      trait Actor
      trait Item

      relation Holds(Actor, Item)
      relation Stamped(Item)

      action Touch(a: Actor, t: Item) {
        when (Holds(a, secret)) { succeed; }
      }

      -- If body env leaked, secret would be bound here from the body's
      -- when. The after-rule must instead stamp the parameter target t.
      after Touch(a: Actor, t: Item) {
        set Stamped(t);
      }

      entity Player { Actor }
      entity Key { Item }
      entity Decoy { Item }

      set {
        Holds(Player, Key);
      }
    `);

    expect(playLanguageCall(model, "Touch(Player, Decoy)").status).toBe("passed");
    expect(model.hasFact("Stamped", [idTerm("Decoy")])).toBe(true);
    // If leakage existed, Stamped(Key) would also exist (the body's secret).
    expect(model.hasFact("Stamped", [idTerm("Key")])).toBe(false);
  });
});

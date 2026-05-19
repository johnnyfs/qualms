import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { language } from "@quealm/qualms";
import {
  buildMockupFrame,
  formatMockupResult,
  initialMockupMenuState,
  selectMockupOption,
} from "../../src/play/mockupState.js";
import { createPlaySession } from "../../src/play/runner.js";

const { loadStoryProgram } = language;

const TUTORIAL = readFileSync(
  join(import.meta.dirname, "../../../stories/tutorial/tutorial.qualms"),
  "utf-8",
);

function loadSession() {
  return createPlaySession(loadStoryProgram(TUTORIAL));
}

function option(frame: ReturnType<typeof buildMockupFrame>, label: string) {
  const found = frame.options.find((candidate) => candidate.label === label);
  if (!found) throw new Error(`missing option ${label}`);
  return found;
}

describe("mockup play runner", () => {
  it("starts from MainMenu(Player) and renders raw details", () => {
    const session = loadSession();
    const frame = buildMockupFrame(session.model, initialMockupMenuState);
    expect(frame.headers[0]).toBe("Cell");
    expect(frame.headers).toContain("visible here: Bars, BoneShard, Cell, Guard, Player");
    expect(frame.headers).toContain("exits: Corridor");
    expect(frame.options.map((o) => o.label)).toContain("go");
    expect(frame.options.map((o) => o.label)).toContain("inventory");
    expect(frame.options.map((o) => o.label)).toContain("talk");
  });

  it("navigates through a submenu and runs an action", () => {
    const session = loadSession();
    const main = buildMockupFrame(session.model, initialMockupMenuState);
    const goTransition = selectMockupOption(session.model, option(main, "go"));
    expect(goTransition.kind).toBe("state");
    if (goTransition.kind !== "state") throw new Error("expected state transition");

    const go = buildMockupFrame(session.model, goTransition.state);
    expect(go.headers[0]).toBe("Go...");
    expect(go.options.map((o) => o.label)).toContain("Corridor");
    const blocked = selectMockupOption(session.model, option(go, "Corridor"));
    expect(blocked.kind).toBe("action");
    if (blocked.kind !== "action") throw new Error("expected action transition");
    expect(blocked.result.status).toBe("failed");
    expect(blocked.result.reasons).toContain("!Opened(Bars)");
  });

  it("uses InventoryMenu for carried-item detail and examination", () => {
    const session = loadSession();
    const main = buildMockupFrame(session.model, initialMockupMenuState);
    const takeMenu = selectMockupOption(session.model, option(main, "take"));
    expect(takeMenu.kind).toBe("state");
    if (takeMenu.kind !== "state") throw new Error("expected take menu");
    const take = buildMockupFrame(session.model, takeMenu.state);
    const taken = selectMockupOption(session.model, option(take, "BoneShard"));
    expect(taken.kind).toBe("action");
    if (taken.kind !== "action") throw new Error("expected take action");
    expect(taken.result.status).toBe("passed");

    const afterTake = buildMockupFrame(session.model, taken.nextState);
    const inventoryMenu = selectMockupOption(session.model, option(afterTake, "inventory"));
    expect(inventoryMenu.kind).toBe("state");
    if (inventoryMenu.kind !== "state") throw new Error("expected inventory menu");
    const inventory = buildMockupFrame(session.model, inventoryMenu.state);
    expect(inventory.headers[0]).toBe("Inventory");
    expect(inventory.headers).toContain("carrying: BoneShard");
    expect(inventory.options.map((o) => o.label)).toContain("BoneShard");
    expect(inventory.options.map((o) => o.label)).toContain("back");
  });

  it("chains TalkTo into the conversation mockup", () => {
    const session = loadSession();
    const main = buildMockupFrame(session.model, initialMockupMenuState);
    const talkToMenu = selectMockupOption(session.model, option(main, "talk"));
    expect(talkToMenu.kind).toBe("state");
    if (talkToMenu.kind !== "state") throw new Error("expected talk menu");

    const talkTo = buildMockupFrame(session.model, talkToMenu.state);
    const started = selectMockupOption(session.model, option(talkTo, "Guard"));
    expect(started.kind).toBe("action");
    if (started.kind !== "action") throw new Error("expected action transition");
    expect(started.result.status).toBe("passed");

    const talk = buildMockupFrame(session.model, started.nextState);
    expect(talk.headers[0]).toBe("Talking to Guard");
    expect(talk.headers).toContain("current topic: Whatever");
    expect(talk.options.map((o) => o.label).sort()).toEqual([
      "Bribery",
      "Weather",
      "leave",
    ]);

    const bribery = selectMockupOption(session.model, option(talk, "Bribery"));
    expect(bribery.kind).toBe("action");
    if (bribery.kind !== "action") throw new Error("expected topic action");
    const nestedTalk = buildMockupFrame(session.model, bribery.nextState);
    expect(nestedTalk.headers).toContain("current topic: Bribery");
    expect(nestedTalk.options.map((o) => o.label)).toContain("change topics");
    expect(nestedTalk.options.map((o) => o.label)).not.toContain("leave");

    const favor = selectMockupOption(session.model, option(nestedTalk, "OfferAFavor"));
    expect(favor.kind).toBe("action");
    if (favor.kind !== "action") throw new Error("expected favor action");
    expect(formatMockupResult(favor.result, undefined)).toEqual([
      "TopicHistory(Player, Guard, OfferAFavor, Bribery)",
      "!InConversation(Player, Guard, Bribery)",
      "InConversation(Player, Guard, OfferAFavor)",
      "!Carrying(Guard, MasterKey)",
      "Carrying(Player, MasterKey)",
      "GuardHandsOver(Player, MasterKey)",
    ]);
  });
});

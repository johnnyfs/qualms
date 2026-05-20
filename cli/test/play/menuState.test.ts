import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { language } from "@quealm/qualms";
import { parsePlayConfig } from "../../src/play/config.js";
import { buildNameIndex } from "../../src/play/naming.js";
import { buildVerbTable } from "../../src/play/verbs.js";
import {
  buildFrame,
  initialMenuState,
  selectOption,
  type MenuContext,
  type MenuState,
} from "../../src/play/menuState.js";

const { loadStoryProgram, playLanguageCall } = language;

const TUTORIAL = readFileSync(
  join(import.meta.dirname, "../../../stories/tutorial/tutorial.qualms"),
  "utf-8",
);

const CONFIG_YAML = `
player: Player
verbs:
  Take: { words: [take] }
  Go: { words: [go], candidates: { 0: Adjacent } }
  Unlock: { words: [unlock], prepositions: { 1: with } }
  TalkTo: { words: [talk to] }
  TalkAbout: { words: [talk about] }
  SwitchTopics: { words: [change topics] }
  StopTalking: { words: [stop talking to] }
  Inventory: { words: [inventory] }
  Visible: { hidden: true }
  Adjacent: { hidden: true }
`;

function setup() {
  const model = loadStoryProgram(TUTORIAL);
  const config = parsePlayConfig(CONFIG_YAML);
  const names = buildNameIndex(model, config);
  const verbs = buildVerbTable(model, config);
  const ctx: MenuContext = { model, config, names, verbs };
  return { model, ctx };
}

describe("buildFrame — root", () => {
  it("lists verbs (excluding mid-conversation actions and conversation queries)", () => {
    const { ctx } = setup();
    const frame = buildFrame({ kind: "root" }, ctx);
    expect(frame.headers).toEqual(["What do you do?"]);
    const verbIds = frame.options
      .filter((o) => o.kind === "verb")
      .map((o) => (o.kind === "verb" ? o.verbId : ""));
    expect(verbIds).toContain("Take");
    expect(verbIds).toContain("TalkTo");
    expect(verbIds).toContain("Inventory");
    // Navigation / back-up / tear-down belong inside a conversation.
    expect(verbIds).not.toContain("TalkAbout");
    expect(verbIds).not.toContain("SwitchTopics");
    expect(verbIds).not.toContain("StopTalking");
    expect(frame.backOption).toBeUndefined();
  });
});

describe("buildFrame — slot", () => {
  it("lists visible entities (opportunistic), excluding player and current location", () => {
    const { ctx } = setup();
    const takeVerb = ctx.verbs.getById("Take")!;
    const state: MenuState = {
      kind: "slot",
      verb: takeVerb,
      slot: 0,
      args: [{ kind: "identifier", id: "Player" }],
    };
    const frame = buildFrame(state, ctx);
    const ids = frame.options
      .filter((o) => o.kind === "candidate")
      .map((o) => (o.kind === "candidate" ? o.id : ""));
    expect(ids).toContain("ActOne.BoneShard");
    expect(ids).toContain("ActOne.Bars");
    expect(ids).toContain("Guard");
    expect(ids).not.toContain("Player");
    expect(ids).not.toContain("Cell");
    expect(frame.backOption?.kind).toBe("back");
  });

  it("uses the verb's per-slot candidates query when configured (Go → Adjacent)", () => {
    const { ctx } = setup();
    const goVerb = ctx.verbs.getById("Go")!;
    const state: MenuState = {
      kind: "slot",
      verb: goVerb,
      slot: 0,
      args: [{ kind: "identifier", id: "Player" }],
    };
    const frame = buildFrame(state, ctx);
    const ids = frame.options
      .filter((o) => o.kind === "candidate")
      .map((o) => (o.kind === "candidate" ? o.id : ""));
    // Cell → Corridor: Path-adjacent. Selectable regardless of door state
    // so a blocked attempt yields a useful denial.
    expect(ids).toEqual(["ActOne.Corridor"]);
    // Visible-only entities (BoneShard, Bars, Guard) must NOT appear; Go
    // targets locations, and the per-slot Adjacent query enforces that.
    expect(ids).not.toContain("ActOne.BoneShard");
    expect(ids).not.toContain("ActOne.Bars");
    expect(ids).not.toContain("Guard");
  });

  it("falls back to Visible when no per-slot candidates query is configured (Take)", () => {
    const { ctx } = setup();
    const takeVerb = ctx.verbs.getById("Take")!;
    const state: MenuState = {
      kind: "slot",
      verb: takeVerb,
      slot: 0,
      args: [{ kind: "identifier", id: "Player" }],
    };
    const frame = buildFrame(state, ctx);
    const ids = frame.options
      .filter((o) => o.kind === "candidate")
      .map((o) => (o.kind === "candidate" ? o.id : ""));
    // Visible enumeration: BoneShard is co-located, Corridor is not visible.
    expect(ids).toContain("ActOne.BoneShard");
    expect(ids).not.toContain("Corridor");
  });

  it("slot 0 header has no preposition or filled arg", () => {
    const { ctx } = setup();
    const unlock = ctx.verbs.getById("Unlock")!;
    const state: MenuState = {
      kind: "slot",
      verb: unlock,
      slot: 0,
      args: [{ kind: "identifier", id: "Player" }],
    };
    const frame = buildFrame(state, ctx);
    expect(frame.headers).toEqual(["Unlock what?"]);
  });

  it("slot 1 header includes prior arg and per-slot preposition", () => {
    const { ctx } = setup();
    const unlock = ctx.verbs.getById("Unlock")!;
    const state: MenuState = {
      kind: "slot",
      verb: unlock,
      slot: 1,
      args: [
        { kind: "identifier", id: "Player" },
        { kind: "identifier", id: "Bars" },
      ],
    };
    const frame = buildFrame(state, ctx);
    expect(frame.headers).toEqual(["Unlock the bars with what?"]);
  });
});

describe("selectOption — root → slot", () => {
  it("picking Take navigates to slot 0", () => {
    const { ctx } = setup();
    const root: MenuState = { kind: "root" };
    const transition = selectOption(
      root,
      { kind: "verb", verbId: "Take", label: "Take" },
      ctx,
    );
    expect(transition.kind).toBe("state");
    if (transition.kind === "state" && transition.state.kind === "slot") {
      expect(transition.state.verb.actionId).toBe("Take");
      expect(transition.state.slot).toBe(0);
      expect(transition.state.args).toEqual([{ kind: "identifier", id: "Player" }]);
    }
  });

  it("picking Inventory (a query, no slots) issues a query transition", () => {
    const { ctx } = setup();
    const transition = selectOption(
      { kind: "root" },
      { kind: "verb", verbId: "Inventory", label: "Inventory" },
      ctx,
    );
    expect(transition.kind).toBe("query");
    if (transition.kind === "query") {
      expect(transition.atom.relation).toBe("Inventory");
      expect(transition.atom.args).toEqual([{ kind: "identifier", id: "Player" }]);
      expect(transition.nextState).toEqual({ kind: "root" });
    }
  });
});

describe("selectOption — slot → submit / next slot", () => {
  it("filling the only slot submits the atom", () => {
    const { ctx } = setup();
    const takeVerb = ctx.verbs.getById("Take")!;
    const state: MenuState = {
      kind: "slot",
      verb: takeVerb,
      slot: 0,
      args: [{ kind: "identifier", id: "Player" }],
    };
    const transition = selectOption(
      state,
      { kind: "candidate", id: "BoneShard", label: "bone shard" },
      ctx,
    );
    expect(transition.kind).toBe("submit");
    if (transition.kind === "submit") {
      expect(transition.atom.relation).toBe("Take");
      expect(transition.atom.args).toEqual([
        { kind: "identifier", id: "Player" },
        { kind: "identifier", id: "BoneShard" },
      ]);
      expect(transition.nextState).toEqual({ kind: "root" });
    }
  });

  it("filling slot 0 of a two-slot action advances to slot 1", () => {
    const { ctx } = setup();
    const unlockVerb = ctx.verbs.getById("Unlock")!;
    const state: MenuState = {
      kind: "slot",
      verb: unlockVerb,
      slot: 0,
      args: [{ kind: "identifier", id: "Player" }],
    };
    const transition = selectOption(
      state,
      { kind: "candidate", id: "Bars", label: "bars" },
      ctx,
    );
    expect(transition.kind).toBe("state");
    if (transition.kind === "state" && transition.state.kind === "slot") {
      expect(transition.state.slot).toBe(1);
      expect(transition.state.args).toEqual([
        { kind: "identifier", id: "Player" },
        { kind: "identifier", id: "Bars" },
      ]);
    }
  });
});

describe("selectOption — conversation flow", () => {
  it("picking a speaker for TalkTo fires the action AND enters conversation", () => {
    const { ctx } = setup();
    const talk = ctx.verbs.getById("TalkTo")!;
    const state: MenuState = {
      kind: "slot",
      verb: talk,
      slot: 0,
      args: [{ kind: "identifier", id: "Player" }],
    };
    const transition = selectOption(
      state,
      { kind: "candidate", id: "Guard", label: "guard" },
      ctx,
    );
    expect(transition.kind).toBe("submit");
    if (transition.kind === "submit") {
      expect(transition.atom.relation).toBe("TalkTo");
      expect(transition.atom.args).toEqual([
        { kind: "identifier", id: "Player" },
        { kind: "identifier", id: "Guard" },
      ]);
      expect(transition.nextState).toEqual({ kind: "conversation", speaker: "Guard" });
    }
  });

  it("Topics is empty before TalkTo opens the conversation", () => {
    const { ctx } = setup();
    const frame = buildFrame({ kind: "conversation", speaker: "Guard" }, ctx);
    expect(frame.headers[0]).toContain("guard");
    const topics = frame.options.filter((o) => o.kind === "topic");
    expect(topics).toEqual([]);
    // No history → back option is "leave".
    expect(frame.backOption?.kind).toBe("stop_talking");
    expect(frame.backOption?.label).toBe("leave");
  });

  it("Topics returns LeadsTo children of the current topic after TalkTo", () => {
    const { model, ctx } = setup();
    expect(playLanguageCall(model, "TalkTo(Player, Guard)").status).toBe("passed");
    const frame = buildFrame({ kind: "conversation", speaker: "Guard" }, ctx);
    const topicIds = frame.options
      .filter((o) => o.kind === "topic")
      .map((o) => (o.kind === "topic" ? o.id : ""))
      .sort();
    expect(topicIds).toEqual(["Bribery", "Weather"]);
    // Root of tree: still no TopicHistory → back is "leave".
    expect(frame.backOption?.kind).toBe("stop_talking");
    expect(frame.backOption?.label).toBe("leave");
  });

  it("back option flips to 'change topics' after navigating to a sub-topic", () => {
    const { model, ctx } = setup();
    expect(playLanguageCall(model, "TalkTo(Player, Guard)").status).toBe("passed");
    expect(playLanguageCall(model, "TalkAbout(Player, Guard, Bribery)").status).toBe(
      "passed",
    );
    const frame = buildFrame({ kind: "conversation", speaker: "Guard" }, ctx);
    const topicIds = frame.options
      .filter((o) => o.kind === "topic")
      .map((o) => (o.kind === "topic" ? o.id : ""))
      .sort();
    expect(topicIds).toEqual(["BriberyIsWrong", "OfferAFavor", "OfferMoney"]);
    expect(frame.backOption?.kind).toBe("switch_topics");
    expect(frame.backOption?.label).toBe("change topics");
  });

  it("picking a topic submits TalkAbout and stays in conversation", () => {
    const { ctx } = setup();
    const transition = selectOption(
      { kind: "conversation", speaker: "Guard" },
      { kind: "topic", id: "Bribery", label: "bribery" },
      ctx,
    );
    expect(transition.kind).toBe("submit");
    if (transition.kind === "submit") {
      expect(transition.atom.relation).toBe("TalkAbout");
      expect(transition.atom.args).toEqual([
        { kind: "identifier", id: "Player" },
        { kind: "identifier", id: "Guard" },
        { kind: "identifier", id: "Bribery" },
      ]);
      expect(transition.nextState).toEqual({ kind: "conversation", speaker: "Guard" });
    }
  });

  it("switch_topics submits SwitchTopics and stays in conversation", () => {
    const { ctx } = setup();
    const transition = selectOption(
      { kind: "conversation", speaker: "Guard" },
      { kind: "switch_topics", label: "change topics" },
      ctx,
    );
    expect(transition.kind).toBe("submit");
    if (transition.kind === "submit") {
      expect(transition.atom.relation).toBe("SwitchTopics");
      expect(transition.atom.args).toEqual([
        { kind: "identifier", id: "Player" },
        { kind: "identifier", id: "Guard" },
      ]);
      expect(transition.nextState).toEqual({ kind: "conversation", speaker: "Guard" });
    }
  });

  it("stop_talking submits StopTalking and returns to root", () => {
    const { ctx } = setup();
    const transition = selectOption(
      { kind: "conversation", speaker: "Guard" },
      { kind: "stop_talking", label: "leave" },
      ctx,
    );
    expect(transition.kind).toBe("submit");
    if (transition.kind === "submit") {
      expect(transition.atom.relation).toBe("StopTalking");
      expect(transition.atom.args).toEqual([
        { kind: "identifier", id: "Player" },
        { kind: "identifier", id: "Guard" },
      ]);
      expect(transition.nextState).toEqual({ kind: "root" });
    }
  });
});

describe("back navigation", () => {
  it("back from slot 0 returns to root", () => {
    const { ctx } = setup();
    const takeVerb = ctx.verbs.getById("Take")!;
    const transition = selectOption(
      {
        kind: "slot",
        verb: takeVerb,
        slot: 0,
        args: [{ kind: "identifier", id: "Player" }],
      },
      { kind: "back", label: "back" },
      ctx,
    );
    expect(transition.kind).toBe("state");
    if (transition.kind === "state") {
      expect(transition.state).toEqual({ kind: "root" });
    }
  });

  it("back from slot N drops the last arg and returns to slot N-1", () => {
    const { ctx } = setup();
    const unlockVerb = ctx.verbs.getById("Unlock")!;
    const transition = selectOption(
      {
        kind: "slot",
        verb: unlockVerb,
        slot: 1,
        args: [
          { kind: "identifier", id: "Player" },
          { kind: "identifier", id: "Bars" },
        ],
      },
      { kind: "back", label: "back" },
      ctx,
    );
    expect(transition.kind).toBe("state");
    if (transition.kind === "state" && transition.state.kind === "slot") {
      expect(transition.state.slot).toBe(0);
      expect(transition.state.args).toEqual([{ kind: "identifier", id: "Player" }]);
    }
  });

  it("back from root is a noop", () => {
    const { ctx } = setup();
    const transition = selectOption(
      { kind: "root" },
      { kind: "back", label: "back" },
      ctx,
    );
    expect(transition.kind).toBe("noop");
  });
});

describe("initialMenuState", () => {
  it("is root", () => {
    expect(initialMenuState).toEqual({ kind: "root" });
  });
});

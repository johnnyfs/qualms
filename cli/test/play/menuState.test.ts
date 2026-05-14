import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { language } from "@quealm/qualms";
import { defaultPlayConfig, parsePlayConfig } from "../../src/play/config.js";
import { buildNameIndex } from "../../src/play/naming.js";
import { buildVerbTable } from "../../src/play/verbs.js";
import {
  buildFrame,
  initialMenuState,
  selectOption,
  type MenuContext,
  type MenuState,
} from "../../src/play/menuState.js";

const { loadStoryProgram } = language;

const TUTORIAL = readFileSync(
  join(import.meta.dirname, "../../../stories/tutorial/tutorial.qualms"),
  "utf-8",
);

const CONFIG_YAML = `
player: Player
verbs:
  Take: { words: [take] }
  Go: { words: [go] }
  Unlock: { words: [unlock] }
  TalkAbout: { words: [talk to] }
  StopTalking: { words: [stop talking to] }
  Inventory: { words: [inventory] }
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
  it("lists verbs (excluding the conversation stopVerb)", () => {
    const { ctx } = setup();
    const frame = buildFrame({ kind: "root" }, ctx);
    expect(frame.headers).toEqual(["What do you do?"]);
    const verbIds = frame.options
      .filter((o) => o.kind === "verb")
      .map((o) => (o.kind === "verb" ? o.verbId : ""));
    expect(verbIds).toContain("Take");
    expect(verbIds).toContain("TalkAbout");
    expect(verbIds).toContain("Inventory");
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
    expect(ids).toContain("BoneShard");
    expect(ids).toContain("Bars");
    expect(ids).toContain("Guard");
    expect(ids).not.toContain("Player");
    expect(ids).not.toContain("Cell");
    expect(frame.backOption?.kind).toBe("back");
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
  it("picking a speaker for TalkAbout enters conversation state (does not submit)", () => {
    const { ctx } = setup();
    const talk = ctx.verbs.getById("TalkAbout")!;
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
    expect(transition.kind).toBe("state");
    if (transition.kind === "state") {
      expect(transition.state).toEqual({ kind: "conversation", speaker: "Guard" });
    }
  });

  it("conversation frame lists topics from the Topics query", () => {
    const { ctx } = setup();
    const frame = buildFrame({ kind: "conversation", speaker: "Guard" }, ctx);
    expect(frame.headers[0]).toContain("guard");
    const topics = frame.options
      .filter((o) => o.kind === "topic")
      .map((o) => (o.kind === "topic" ? o.id : ""));
    // Pre-conversation: only "Whatever" is available.
    expect(topics).toEqual(["Whatever"]);
    expect(frame.backOption?.kind).toBe("stop_talking");
  });

  it("picking a topic submits TalkAbout and stays in conversation", () => {
    const { ctx } = setup();
    const transition = selectOption(
      { kind: "conversation", speaker: "Guard" },
      { kind: "topic", id: "Whatever", label: "whatever" },
      ctx,
    );
    expect(transition.kind).toBe("submit");
    if (transition.kind === "submit") {
      expect(transition.atom.relation).toBe("TalkAbout");
      expect(transition.atom.args).toEqual([
        { kind: "identifier", id: "Player" },
        { kind: "identifier", id: "Guard" },
        { kind: "identifier", id: "Whatever" },
      ]);
      expect(transition.nextState).toEqual({ kind: "conversation", speaker: "Guard" });
    }
  });

  it("stop_talking submits StopTalking and returns to root", () => {
    const { ctx } = setup();
    const transition = selectOption(
      { kind: "conversation", speaker: "Guard" },
      { kind: "stop_talking", label: "stop talking" },
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

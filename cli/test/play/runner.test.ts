import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { language } from "@quealm/qualms";
import { loadPlayConfig } from "../../src/play/config.js";
import {
  createPlaySession,
  handleMenuSubmit,
  renderInitialView,
} from "../../src/play/runner.js";

const { loadStoryProgram } = language;

const TUTORIAL = readFileSync(
  join(import.meta.dirname, "../../../stories/tutorial/tutorial.qualms"),
  "utf-8",
);
const SIDECAR_PATH = join(
  import.meta.dirname,
  "../../../stories/tutorial/tutorial.play.yaml",
);

function id(name: string): language.Term {
  return { kind: "identifier", id: name };
}

describe("handleMenuSubmit — golden paths", () => {
  it("takes the bone shard and updates the model", () => {
    const config = loadPlayConfig(SIDECAR_PATH);
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, config);
    const submit = handleMenuSubmit(session, {
      relation: "Take",
      args: [id("Player"), id("BoneShard")],
    });
    expect(submit.result?.status).toBe("passed");
    expect(submit.entries.map((e) => e.text)).toContain("You take the bone shard.");
    expect(
      model.hasFact("Carrying", [
        { kind: "id", id: "Player" },
        { kind: "id", id: "BoneShard" },
      ]),
    ).toBe(true);
  });

  it("Go to Corridor fails because the Bars are locked", () => {
    const config = loadPlayConfig(SIDECAR_PATH);
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, config);
    const submit = handleMenuSubmit(session, {
      relation: "Go",
      args: [id("Player"), id("Corridor")],
    });
    expect(submit.result?.status).toBe("failed");
    expect(
      model.hasFact("At", [
        { kind: "id", id: "Player" },
        { kind: "id", id: "Cell" },
      ]),
    ).toBe(true);
  });

  it("renders the initial room view before any input", () => {
    const config = loadPlayConfig(SIDECAR_PATH);
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, config);
    const entries = renderInitialView(session);
    expect(entries.some((e) => e.kind === "title" && e.text === "Cell")).toBe(true);
  });
});

describe("handleMenuSubmit — query atoms", () => {
  it("inventory walks empty → take bone shard → carrying it", () => {
    const config = loadPlayConfig(SIDECAR_PATH);
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, config);

    const empty = handleMenuSubmit(session, {
      relation: "Inventory",
      args: [id("Player")],
    });
    expect(empty.entries.map((e) => e.text)).toContain("You're empty-handed.");

    handleMenuSubmit(session, {
      relation: "Take",
      args: [id("Player"), id("BoneShard")],
    });

    const after = handleMenuSubmit(session, {
      relation: "Inventory",
      args: [id("Player")],
    });
    expect(after.entries.map((e) => e.text)).toContain("You're carrying the bone shard.");
  });
});

describe("handleMenuSubmit — DSL-tied failure denials", () => {
  it("unlock bars with bone shard surfaces a DSL-tied denial, not an invented message", () => {
    const config = loadPlayConfig(SIDECAR_PATH);
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, config);
    const submit = handleMenuSubmit(session, {
      relation: "Unlock",
      args: [id("Player"), id("Bars"), id("BoneShard")],
    });
    expect(submit.result?.status).toBe("failed");
    const errors = submit.entries.filter((e) => e.kind === "error");
    expect(errors.some((e) => /don't see/i.test(e.text))).toBe(false);
    expect(
      errors.some((e) => /can't unlock the bars with the bone shard/i.test(e.text)),
    ).toBe(true);
  });
});

describe("handleMenuSubmit — conversation flow", () => {
  function start() {
    const config = loadPlayConfig(SIDECAR_PATH);
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, config);
    return { config, model, session };
  }

  it("TalkTo opens conversation at Whatever", () => {
    const { model, session } = start();
    const submit = handleMenuSubmit(session, {
      relation: "TalkTo",
      args: [id("Player"), id("Guard")],
    });
    expect(submit.result?.status).toBe("passed");
    expect(
      model.hasFact("InConversation", [
        { kind: "id", id: "Player" },
        { kind: "id", id: "Guard" },
        { kind: "id", id: "Whatever" },
      ]),
    ).toBe(true);
  });

  it("TalkAbout descends the tree and records TopicHistory", () => {
    const { model, session } = start();
    handleMenuSubmit(session, {
      relation: "TalkTo",
      args: [id("Player"), id("Guard")],
    });
    const submit = handleMenuSubmit(session, {
      relation: "TalkAbout",
      args: [id("Player"), id("Guard"), id("Bribery")],
    });
    expect(submit.result?.status).toBe("passed");
    expect(
      model.hasFact("InConversation", [
        { kind: "id", id: "Player" },
        { kind: "id", id: "Guard" },
        { kind: "id", id: "Bribery" },
      ]),
    ).toBe(true);
    expect(
      model.hasFact("TopicHistory", [
        { kind: "id", id: "Player" },
        { kind: "id", id: "Guard" },
        { kind: "id", id: "Bribery" },
        { kind: "id", id: "Whatever" },
      ]),
    ).toBe(true);
  });

  it("OfferAFavor transfers the master key and emits GuardHandsOver", () => {
    const { model, session } = start();
    handleMenuSubmit(session, {
      relation: "TalkTo",
      args: [id("Player"), id("Guard")],
    });
    handleMenuSubmit(session, {
      relation: "TalkAbout",
      args: [id("Player"), id("Guard"), id("Bribery")],
    });
    const submit = handleMenuSubmit(session, {
      relation: "TalkAbout",
      args: [id("Player"), id("Guard"), id("OfferAFavor")],
    });
    expect(submit.result?.status).toBe("passed");
    expect(submit.result?.events.some((e) => e.event === "GuardHandsOver")).toBe(true);
    expect(
      model.hasFact("Carrying", [
        { kind: "id", id: "Player" },
        { kind: "id", id: "MasterKey" },
      ]),
    ).toBe(true);
    expect(
      model.hasFact("Carrying", [
        { kind: "id", id: "Guard" },
        { kind: "id", id: "MasterKey" },
      ]),
    ).toBe(false);
    // The consequence line should surface in the rendered transcript.
    expect(
      submit.entries.some((e) => /guard slips you the master key/i.test(e.text)),
    ).toBe(true);
  });

  it("SwitchTopics walks back one step along TopicHistory", () => {
    const { model, session } = start();
    handleMenuSubmit(session, {
      relation: "TalkTo",
      args: [id("Player"), id("Guard")],
    });
    handleMenuSubmit(session, {
      relation: "TalkAbout",
      args: [id("Player"), id("Guard"), id("Bribery")],
    });
    const submit = handleMenuSubmit(session, {
      relation: "SwitchTopics",
      args: [id("Player"), id("Guard")],
    });
    expect(submit.result?.status).toBe("passed");
    expect(
      model.hasFact("InConversation", [
        { kind: "id", id: "Player" },
        { kind: "id", id: "Guard" },
        { kind: "id", id: "Whatever" },
      ]),
    ).toBe(true);
    expect(
      model.hasFact("TopicHistory", [
        { kind: "id", id: "Player" },
        { kind: "id", id: "Guard" },
        { kind: "id", id: "Bribery" },
        { kind: "id", id: "Whatever" },
      ]),
    ).toBe(false);
  });

  it("StopTalking clears InConversation", () => {
    const { model, session } = start();
    handleMenuSubmit(session, {
      relation: "TalkTo",
      args: [id("Player"), id("Guard")],
    });
    const submit = handleMenuSubmit(session, {
      relation: "StopTalking",
      args: [id("Player"), id("Guard")],
    });
    expect(submit.result?.status).toBe("passed");
    expect(
      model.hasFact("InConversation", [
        { kind: "id", id: "Player" },
        { kind: "id", id: "Guard" },
        { kind: "id", id: "Whatever" },
      ]),
    ).toBe(false);
  });
});

describe("handleMenuSubmit — unknown atom", () => {
  it("returns an error entry for unknown atoms", () => {
    const config = loadPlayConfig(SIDECAR_PATH);
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, config);
    const submit = handleMenuSubmit(session, {
      relation: "Frobnicate",
      args: [id("Player")],
    });
    expect(submit.result).toBeUndefined();
    expect(submit.queryResult).toBeUndefined();
    expect(submit.entries.some((e) => /unknown action or query/i.test(e.text))).toBe(
      true,
    );
  });
});

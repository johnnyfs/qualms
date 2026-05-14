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

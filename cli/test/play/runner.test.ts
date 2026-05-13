import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { language } from "@quealm/qualms";
import { loadPlayConfig, parsePlayConfig } from "../../src/play/config.js";
import {
  createPlaySession,
  handlePlayInput,
  renderInitialView,
} from "../../src/play/runner.js";

const { loadStoryProgram } = language;

const TUTORIAL = readFileSync(
  join(import.meta.dirname, "../../../stories/tutorial/tutorial.qualms"),
  "utf-8",
);

const CONFIG = parsePlayConfig(`
player: Player
synonyms:
  MasterKey: [key, master]
  MakeshiftKey: [shiv]
  Bars: [door, gate]
descriptions:
  Cell: "A grim stone cell."
  Corridor: "A dim corridor."
presentations:
  BoneShard: "A bone shard lies in the dust."
  Bars: "Iron bars seal the corridor."
  Guard: "A guard slouches against the wall."
verbs:
  Go: { words: [go], prepositions: { 0: to } }
  Take: { words: [take, grab, get] }
  Drop: { words: [drop] }
  Examine: { words: [examine, look at, x] }
  Open: { words: [open] }
  Close: { words: [close] }
  Unlock: { words: [unlock], prepositions: { 1: with } }
  Lock: { words: [lock], prepositions: { 1: with } }
  TalkAbout: { words: [talk to, ask], prepositions: { 1: about } }
  StopTalking: { words: [stop talking to] }
`);

describe("handlePlayInput — golden paths", () => {
  it("takes the bone shard and updates the model", () => {
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, CONFIG);
    const entries = handlePlayInput(session, "take bone shard");
    const texts = entries.map((e) => e.text);
    expect(texts).toContain("You take the bone shard.");
    expect(
      model.hasFact("Carrying", [
        { kind: "id", id: "Player" },
        { kind: "id", id: "BoneShard" },
      ]),
    ).toBe(true);
  });

  it("walks Cell → Corridor (after opening Bars… which is locked)", () => {
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, CONFIG);
    // Bars are locked at start; Go(Player, Corridor) should fail with !Opened(Bars) or similar.
    const entries = handlePlayInput(session, "go to corridor");
    const texts = entries.map((e) => e.text);
    // The result line should appear before the room title — any non-"You go" message is fine for failure.
    const messageLine = texts.find(
      (t) => t.length > 0 && t !== "Cell" && !t.startsWith("A "),
    );
    expect(messageLine).toBeDefined();
    expect(messageLine).not.toBe("You go to the corridor.");
    // Player is still at Cell
    expect(
      model.hasFact("At", [
        { kind: "id", id: "Player" },
        { kind: "id", id: "Cell" },
      ]),
    ).toBe(true);
  });

  it("emits an error entry for an unparseable command", () => {
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, CONFIG);
    const entries = handlePlayInput(session, "befuddle the quasar");
    const errors = entries.filter((e) => e.kind === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.text).toMatch(/i don't know how to/i);
  });

  it("renders the initial room view before any input", () => {
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, CONFIG);
    const entries = renderInitialView(session);
    expect(entries.some((e) => e.kind === "title" && e.text === "Cell")).toBe(true);
    expect(
      entries.some(
        (e) => e.kind === "narrative" && e.text === "A grim stone cell.",
      ),
    ).toBe(true);
  });

  it("ambiguity surfaces a helpful error", () => {
    const ambiguousConfig = parsePlayConfig(`
player: Player
synonyms:
  MasterKey: [key]
  MakeshiftKey: [key]
verbs:
  Take: { words: [take] }
`);
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, ambiguousConfig);
    const entries = handlePlayInput(session, "take key");
    const errors = entries.filter((e) => e.kind === "error");
    expect(errors[0]?.text).toMatch(/makeshift key|master key/i);
  });

  it("empty input produces no entries", () => {
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, CONFIG);
    expect(handlePlayInput(session, "")).toEqual([]);
    expect(handlePlayInput(session, "   ")).toEqual([]);
  });
});

describe("handlePlayInput — sample tutorial.play.yaml end-to-end", () => {
  const SIDECAR_PATH = join(
    import.meta.dirname,
    "../../../stories/tutorial/tutorial.play.yaml",
  );

  it("loads the sidecar config, takes the bone shard via 'grab shard'", () => {
    const config = loadPlayConfig(SIDECAR_PATH);
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, config);
    const entries = handlePlayInput(session, "grab bone shard");
    expect(entries.some((e) => e.text === "You take the bone shard.")).toBe(true);
    expect(
      model.hasFact("Carrying", [
        { kind: "id", id: "Player" },
        { kind: "id", id: "BoneShard" },
      ]),
    ).toBe(true);
  });

  it("uses configured descriptions/presentations in the initial view", () => {
    const config = loadPlayConfig(SIDECAR_PATH);
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, config);
    const entries = renderInitialView(session);
    const texts = entries.map((e) => e.text);
    expect(texts).toContain(
      "A cramped stone cell. Iron bars seal the only exit; a corridor lies beyond.",
    );
    expect(texts).toContain("A jagged bone shard glints in the dust.");
    expect(texts).toContain("Iron bars seal the way to the corridor.");
    expect(texts).toContain(
      "A guard slouches against the corridor wall, watching you.",
    );
  });

  it("inventory walks empty → take bone shard → carrying it", () => {
    const config = loadPlayConfig(SIDECAR_PATH);
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, config);

    const empty = handlePlayInput(session, "inventory");
    expect(empty.map((e) => e.text)).toContain("You're empty-handed.");

    handlePlayInput(session, "take bone shard");

    const after = handlePlayInput(session, "i");
    expect(after.map((e) => e.text)).toContain("You're carrying the bone shard.");
  });

  it("unlock bars with bone shard surfaces a DSL-tied denial, not a parser invention", () => {
    const config = loadPlayConfig(SIDECAR_PATH);
    const model = loadStoryProgram(TUTORIAL);
    const session = createPlaySession(model, config);
    const entries = handlePlayInput(session, "unlock bars with bone shard");
    const errors = entries.filter((e) => e.kind === "error");
    // Should NOT pretend the bone shard isn't here.
    expect(errors.some((e) => /don't see/i.test(e.text))).toBe(false);
    // SHOULD render a denial sentence tied to the action.
    expect(
      errors.some((e) => /can't unlock the bars with the bone shard/i.test(e.text)),
    ).toBe(true);
  });
});

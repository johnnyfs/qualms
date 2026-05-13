import { describe, expect, it } from "vitest";
import { language } from "@quealm/qualms";
import { buildVerbTable } from "../../src/play/verbs.js";
import { defaultPlayConfig, parsePlayConfig } from "../../src/play/config.js";

const { loadStoryProgram } = language;

const SOURCE = `
  trait Actor
  trait Locatable
  trait Location
  trait Speaker
  trait Topic
  relation At(subject: Locatable, location: Location) unique(subject)
  relation TalksAbout(Speaker, Topic)
  action Take(actor: Actor, target: Locatable) { when (At(actor, target)) { succeed; } }
  action Go(actor: Actor, target: Location) { succeed; }
  action TalkAbout(actor: Actor, speaker: Speaker, topic: Topic) {
    when (TalksAbout(speaker, topic)) { succeed; }
  }
  entity Player { Actor, Locatable }
  entity Cell { Location }
`;

const model = loadStoryProgram(SOURCE);

describe("buildVerbTable", () => {
  it("derives default verb surface forms from action ids", () => {
    const table = buildVerbTable(model, defaultPlayConfig());
    expect(table.getById("Take")?.words).toEqual(["take"]);
    expect(table.getById("Go")?.words).toEqual(["go"]);
    expect(table.getById("TalkAbout")?.words).toEqual(["talk about"]);
  });

  it("replaces defaults with config words (does not merge)", () => {
    const config = parsePlayConfig(`
verbs:
  Take: { words: [grab, snatch] }
  Go: { words: [go, walk, move] }
`);
    const table = buildVerbTable(model, config);
    expect(table.getById("Take")?.words).toEqual(["grab", "snatch"]);
    expect(table.getById("Go")?.words).toEqual(["go", "walk", "move"]);
    // unmodified verb keeps default
    expect(table.getById("TalkAbout")?.words).toEqual(["talk about"]);
  });

  it("looks up by leading verb phrase, returning tail", () => {
    const table = buildVerbTable(model, defaultPlayConfig());
    expect(table.lookup("take master key")).toEqual({
      verb: table.getById("Take"),
      word: "take",
      tail: "master key",
    });
    expect(table.lookup("go to cell")).toEqual({
      verb: table.getById("Go"),
      word: "go",
      tail: "to cell",
    });
    expect(table.lookup("nope")).toBeUndefined();
  });

  it("prefers longest match for multi-word verbs", () => {
    const config = parsePlayConfig(`
verbs:
  TalkAbout: { words: [talk about, talk] }
`);
    const table = buildVerbTable(model, config);
    const hit = table.lookup("talk about weather");
    expect(hit?.verb.actionId).toBe("TalkAbout");
    expect(hit?.word).toBe("talk about");
    expect(hit?.tail).toBe("weather");
  });

  it("returns parameters and prepositions on the entry", () => {
    const config = parsePlayConfig(`
verbs:
  TalkAbout: { words: [talk to], prepositions: { 1: about } }
`);
    const table = buildVerbTable(model, config);
    const entry = table.getById("TalkAbout");
    expect(entry?.parameters.length).toBe(3);
    expect(entry?.prepositions.get(1)).toBe("about");
  });

  it("treats verb words case-insensitively and normalizes whitespace", () => {
    const config = parsePlayConfig(`
verbs:
  TalkAbout: { words: ["  TALK   ABOUT  "] }
`);
    const table = buildVerbTable(model, config);
    expect(table.getById("TalkAbout")?.words).toEqual(["talk about"]);
    expect(table.lookup("TALK ABOUT weather")?.verb.actionId).toBe("TalkAbout");
  });

  it("does not match a verb that is only a prefix of a longer non-space word", () => {
    const table = buildVerbTable(model, defaultPlayConfig());
    // "taken" does not start with "take " — the verb requires a word boundary
    expect(table.lookup("taken")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { language } from "@quealm/qualms";
import { buildNameIndex } from "../../src/play/naming.js";
import { buildVerbTable } from "../../src/play/verbs.js";
import { defaultPlayConfig, parsePlayConfig } from "../../src/play/config.js";
import { parsePlayInput, type ParseOutcome } from "../../src/play/parse.js";

const { loadStoryProgram } = language;

const TUTORIAL = readFileSync(
  join(import.meta.dirname, "../../../stories/tutorial/tutorial.qualms"),
  "utf-8",
);

const TUTORIAL_CONFIG = parsePlayConfig(`
player: Player
synonyms:
  MasterKey: [key, master]
  MakeshiftKey: [shiv]
  Bars: [door, gate]
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

function setup(config = TUTORIAL_CONFIG) {
  const model = loadStoryProgram(TUTORIAL);
  const verbs = buildVerbTable(model, config);
  const names = buildNameIndex(model, config);
  return (text: string): ParseOutcome =>
    parsePlayInput(text, { verbs, names, config });
}

describe("parsePlayInput", () => {
  const parse = setup();

  it("rejects empty input", () => {
    expect(parse("").kind).toBe("empty");
    expect(parse("   ").kind).toBe("empty");
  });

  it("rejects unknown verbs", () => {
    const r = parse("yoink the key");
    expect(r.kind).toBe("unknown_verb");
  });

  it("parses a single-object verb with implicit player", () => {
    const r = parse("take bone shard");
    expect(r).toMatchObject({
      kind: "ok",
      atom: {
        relation: "Take",
        args: [
          { kind: "identifier", id: "Player" },
          { kind: "identifier", id: "BoneShard" },
        ],
      },
    });
  });

  it("resolves synonyms", () => {
    const r = parse("take master");
    expect(r).toMatchObject({
      kind: "ok",
      atom: { relation: "Take", args: [{ id: "Player" }, { id: "MasterKey" }] },
    });
  });

  it("flags ambiguous nouns when multiple ids share a synonym", () => {
    const ambiguousConfig = parsePlayConfig(`
synonyms:
  MasterKey: [key]
  MakeshiftKey: [key]
verbs:
  Take: { words: [take] }
`);
    const parseAmbiguous = setup(ambiguousConfig);
    const r = parseAmbiguous("take key");
    expect(r.kind).toBe("ambiguous_noun");
    if (r.kind === "ambiguous_noun") {
      expect(r.candidates).toEqual(["MakeshiftKey", "MasterKey"]);
    }
  });

  it("handles prepositions for Go (preposition at slot 0)", () => {
    const r = parse("go to corridor");
    expect(r).toMatchObject({
      kind: "ok",
      atom: { relation: "Go", args: [{ id: "Player" }, { id: "Corridor" }] },
    });
  });

  it("rejects missing required preposition", () => {
    const r = parse("go corridor");
    expect(r.kind).toBe("missing_preposition");
    if (r.kind === "missing_preposition") expect(r.preposition).toBe("to");
  });

  it("parses three-arg actions with mid-phrase preposition (Unlock)", () => {
    const r = parse("unlock bars with master key");
    expect(r).toMatchObject({
      kind: "ok",
      atom: {
        relation: "Unlock",
        args: [{ id: "Player" }, { id: "Bars" }, { id: "MasterKey" }],
      },
    });
  });

  it("parses TalkAbout with two noun slots", () => {
    const r = parse("talk to guard about bribery");
    expect(r).toMatchObject({
      kind: "ok",
      atom: {
        relation: "TalkAbout",
        args: [{ id: "Player" }, { id: "Guard" }, { id: "Bribery" }],
      },
    });
  });

  it("returns unknown_noun for unrecognized phrases", () => {
    const r = parse("take quasar");
    expect(r.kind).toBe("unknown_noun");
    if (r.kind === "unknown_noun") expect(r.phrase).toBe("quasar");
  });

  it("does not filter candidates by parameter type — domain validity is the DSL's job", () => {
    // Bribery is Topic, not Portable. The parser still produces Take(Player, Bribery);
    // the DSL runtime rejects at execution time.
    const r = parse("take bribery");
    expect(r).toMatchObject({
      kind: "ok",
      atom: { relation: "Take", args: [{ id: "Player" }, { id: "Bribery" }] },
    });
  });

  it("uses multi-word verb forms via longest match", () => {
    // "stop talking to guard" — "stop talking to" is the verb, "guard" the noun.
    const r = parse("stop talking to guard");
    expect(r).toMatchObject({
      kind: "ok",
      atom: {
        relation: "StopTalking",
        args: [{ id: "Player" }, { id: "Guard" }],
      },
    });
  });

  it("returns missing_noun when phrase is empty", () => {
    const r = parse("take");
    expect(r.kind).toBe("missing_noun");
  });

  it("treats input case-insensitively", () => {
    const r = parse("TAKE Bone Shard");
    expect(r).toMatchObject({
      kind: "ok",
      atom: { relation: "Take", args: [{ id: "Player" }, { id: "BoneShard" }] },
    });
  });
});

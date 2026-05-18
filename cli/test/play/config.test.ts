import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { language } from "@quealm/qualms";
import {
  defaultPlayConfig,
  discoverPlayConfigPath,
  loadPlayConfig,
  parsePlayConfig,
  PlayConfigError,
  validatePlayConfig,
} from "../../src/play/config.js";

const { loadStoryProgram } = language;

describe("parsePlayConfig", () => {
  it("returns default config for empty YAML", () => {
    const config = parsePlayConfig("");
    expect(config.player).toBe("Player");
    expect(config.names.size).toBe(0);
    expect(config.visibility).toEqual({ predicate: "IsVisibleTo", locationFact: "At" });
    expect(config.view).toEqual({ kind: "menu" });
    expect(config.conversation).toEqual({
      startVerb: "TalkTo",
      navigateVerb: "TalkAbout",
      switchVerb: "SwitchTopics",
      stopVerb: "StopTalking",
      topicsQuery: "Topics",
      currentTopicQuery: "CurrentTopic",
      previousTopicQuery: "PreviousTopic",
    });
  });

  it("parses an explicit conversation block", () => {
    const config = parsePlayConfig(`
conversation:
  startVerb: Speak
  stopVerb: Hush
`);
    expect(config.conversation.startVerb).toBe("Speak");
    expect(config.conversation.stopVerb).toBe("Hush");
    expect(config.conversation.topicsQuery).toBe("Topics");
    expect(config.conversation.currentTopicQuery).toBe("CurrentTopic");
  });

  it("rejects unsupported view kinds", () => {
    expect(() => parsePlayConfig("view:\n  kind: nethack")).toThrow(PlayConfigError);
  });

  it("parses a full config", () => {
    const config = parsePlayConfig(`
player: Hero
names:
  MasterKey: heavy key
synonyms:
  MasterKey: [key, brass]
descriptions:
  Cell: A stone cell.
presentations:
  BoneShard: A bone shard lies here.
visibility:
  predicate: CanSee
  locationFact: LocatedAt
verbs:
  Take:
    words: [take, grab]
    prepositions:
      1: from
    template: "$actor takes $target."
    hidden: false
  Go:
    words: [go]
    candidates:
      0: Adjacent
events:
  Took: "$actor took $target."
view:
  kind: infocom
`);
    expect(config.player).toBe("Hero");
    expect(config.names.get("MasterKey")).toBe("heavy key");
    expect(config.synonyms.get("MasterKey")).toEqual(["key", "brass"]);
    expect(config.descriptions.get("Cell")).toBe("A stone cell.");
    expect(config.presentations.get("BoneShard")).toBe("A bone shard lies here.");
    expect(config.visibility).toEqual({ predicate: "CanSee", locationFact: "LocatedAt" });
    const take = config.verbs.get("Take");
    expect(take?.words).toEqual(["take", "grab"]);
    expect(take?.prepositions?.get(1)).toBe("from");
    expect(take?.candidates).toBeUndefined();
    const go = config.verbs.get("Go");
    expect(go?.candidates?.get(0)).toBe("Adjacent");
    expect(take?.template).toBe("$actor takes $target.");
    expect(take?.hidden).toBe(false);
    expect(config.events.get("Took")).toBe("$actor took $target.");
  });

  it("rejects invalid yaml types", () => {
    expect(() => parsePlayConfig("- 1\n- 2\n")).toThrow(PlayConfigError);
    expect(() => parsePlayConfig("names: 42")).toThrow(PlayConfigError);
    expect(() => parsePlayConfig("synonyms:\n  Foo: hi")).toThrow(PlayConfigError);
    expect(() => parsePlayConfig("verbs: 5")).toThrow(PlayConfigError);
    expect(() => parsePlayConfig("verbs:\n  Take:\n    words: 5")).toThrow(PlayConfigError);
    expect(() => parsePlayConfig("verbs:\n  Take:\n    prepositions:\n      foo: bar")).toThrow(
      PlayConfigError,
    );
    expect(() => parsePlayConfig("verbs:\n  Go:\n    candidates: 5")).toThrow(PlayConfigError);
    expect(() => parsePlayConfig("verbs:\n  Go:\n    candidates:\n      foo: Bar")).toThrow(
      PlayConfigError,
    );
    expect(() => parsePlayConfig("verbs:\n  Go:\n    candidates:\n      0: \"\"")).toThrow(
      PlayConfigError,
    );
    expect(() => parsePlayConfig("view:\n  kind: nethack")).toThrow(PlayConfigError);
    expect(() => parsePlayConfig("conversation:\n  startVerb: \"\"")).toThrow(PlayConfigError);
  });
});

describe("discoverPlayConfigPath", () => {
  it("finds sibling <base>.play.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "qualms-config-"));
    const storyPath = join(dir, "story.qualms");
    const configPath = join(dir, "story.play.yaml");
    writeFileSync(storyPath, "");
    writeFileSync(configPath, "player: Player\n");
    expect(discoverPlayConfigPath(storyPath)).toBe(configPath);
  });

  it("returns undefined when no sibling exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "qualms-config-"));
    const storyPath = join(dir, "story.qualms");
    writeFileSync(storyPath, "");
    expect(discoverPlayConfigPath(storyPath)).toBeUndefined();
  });
});

describe("loadPlayConfig", () => {
  it("reads and parses a YAML file with source set", () => {
    const dir = mkdtempSync(join(tmpdir(), "qualms-config-"));
    const path = join(dir, "x.play.yaml");
    writeFileSync(path, "player: Hero\n");
    const config = loadPlayConfig(path);
    expect(config.player).toBe("Hero");
    expect(config.source).toBe(path);
  });
});

describe("validatePlayConfig", () => {
  const source = `
    trait Actor
    trait Locatable
    trait Location
    relation At(subject: Locatable, location: Location) unique(subject)
    action Take(actor: Actor, target: Locatable) { when (At(actor, target)) { succeed; } }
    entity Player { Actor, Locatable }
    entity Cell { Location }
  `;
  const model = loadStoryProgram(source);

  it("warns on unknown entity / action / predicate ids", () => {
    const config = parsePlayConfig(`
player: NotAnEntity
names:
  GhostEntity: ghost
verbs:
  NotAnAction: { words: [poof] }
visibility:
  predicate: GhostPredicate
`);
    const warnings = validatePlayConfig(config, model);
    expect(warnings.some((w) => w.includes("player 'NotAnEntity'"))).toBe(true);
    expect(warnings.some((w) => w.includes("names.GhostEntity"))).toBe(true);
    expect(warnings.some((w) => w.includes("verbs.NotAnAction"))).toBe(true);
    expect(warnings.some((w) => w.includes("GhostPredicate"))).toBe(true);
  });

  it("produces no warnings for a valid config against the model", () => {
    const config = parsePlayConfig(`
player: Player
names:
  Cell: cell
verbs:
  Take: { words: [take] }
visibility:
  predicate: IsVisibleTo
`);
    // IsVisibleTo isn't defined in this model but is the default — only warns if explicitly set to something missing.
    // Adjust the config to use a different predicate to test the no-warning path.
    const cleanConfig = parsePlayConfig(`
player: Player
names:
  Cell: cell
verbs:
  Take: { words: [take] }
`);
    const warnings = validatePlayConfig(cleanConfig, model);
    expect(warnings).toEqual([]);
    // Sanity: the explicit-default-predicate case should also pass since we only warn when set != default && missing.
    expect(validatePlayConfig(config, model)).toEqual([]);
  });

  it("defaults visibility to At/IsVisibleTo and only warns when locationFact relation missing", () => {
    const config = parsePlayConfig(`
player: Player
visibility:
  locationFact: NotARelation
`);
    const warnings = validatePlayConfig(config, model);
    expect(warnings.some((w) => w.includes("NotARelation"))).toBe(true);
  });
});

describe("defaultPlayConfig", () => {
  it("returns a usable empty config", () => {
    const config = defaultPlayConfig();
    expect(config.player).toBe("Player");
    expect(config.visibility.predicate).toBe("IsVisibleTo");
    expect(config.visibility.locationFact).toBe("At");
    expect(config.view.kind).toBe("menu");
  });
});

import { describe, expect, it } from "vitest";
import { language } from "@quealm/qualms";
import { buildNameIndex, defaultDisplayName, tokenizeCamelCase } from "../../src/play/naming.js";
import { defaultPlayConfig, parsePlayConfig } from "../../src/play/config.js";

const { loadStoryProgram } = language;

describe("tokenizeCamelCase", () => {
  it("splits simple PascalCase", () => {
    expect(tokenizeCamelCase("MasterKey")).toEqual(["Master", "Key"]);
    expect(tokenizeCamelCase("BoneShard")).toEqual(["Bone", "Shard"]);
    expect(tokenizeCamelCase("TalkAbout")).toEqual(["Talk", "About"]);
  });

  it("returns single token for non-camel ids", () => {
    expect(tokenizeCamelCase("Player")).toEqual(["Player"]);
    expect(tokenizeCamelCase("cell")).toEqual(["cell"]);
  });

  it("handles runs of uppercase before lowercase", () => {
    expect(tokenizeCamelCase("URLEncoder")).toEqual(["URL", "Encoder"]);
  });

  it("handles empty input", () => {
    expect(tokenizeCamelCase("")).toEqual([]);
  });
});

describe("defaultDisplayName", () => {
  it("lowercases and joins tokens with spaces", () => {
    expect(defaultDisplayName("MasterKey")).toBe("master key");
    expect(defaultDisplayName("MakeshiftKey")).toBe("makeshift key");
    expect(defaultDisplayName("ClosetDoor")).toBe("closet door");
    expect(defaultDisplayName("Player")).toBe("player");
  });
});

describe("buildNameIndex", () => {
  const source = `
    trait Locatable
    trait Location
    relation At(subject: Locatable, location: Location) unique(subject)
    entity Player { Locatable }
    entity Cell { Location }
    entity MasterKey { Locatable }
    entity MakeshiftKey { Locatable }
  `;
  const model = loadStoryProgram(source);

  it("returns default camelcase names when no config overrides", () => {
    const index = buildNameIndex(model, defaultPlayConfig());
    expect(index.displayName("MasterKey")).toBe("master key");
    expect(index.displayName("Player")).toBe("player");
  });

  it("applies config name overrides", () => {
    const config = parsePlayConfig(`names:\n  MasterKey: heavy iron key\n`);
    const index = buildNameIndex(model, config);
    expect(index.displayName("MasterKey")).toBe("heavy iron key");
    expect(index.displayName("MakeshiftKey")).toBe("makeshift key");
  });

  it("resolves nouns case-insensitively and via synonyms", () => {
    const config = parsePlayConfig(
      `synonyms:\n  MasterKey: [key, master]\n  MakeshiftKey: [shiv]\n`,
    );
    const index = buildNameIndex(model, config);
    expect(index.resolveNoun("master key")).toEqual(["MasterKey"]);
    expect(index.resolveNoun("MASTER KEY")).toEqual(["MasterKey"]);
    expect(index.resolveNoun("master")).toEqual(["MasterKey"]);
    expect(index.resolveNoun("shiv")).toEqual(["MakeshiftKey"]);
    expect(index.resolveNoun("key")).toEqual(["MasterKey"]);
    expect(index.resolveNoun("nope")).toEqual([]);
  });

  it("returns multiple ids on ambiguous noun, sorted lexicographically", () => {
    const config = parsePlayConfig(
      `synonyms:\n  MasterKey: [key]\n  MakeshiftKey: [key]\n`,
    );
    const index = buildNameIndex(model, config);
    expect(index.resolveNoun("key")).toEqual(["MakeshiftKey", "MasterKey"]);
  });

  it("includes every entity in allNouns", () => {
    const index = buildNameIndex(model, defaultPlayConfig());
    const names = index.allNouns().map((n) => n.name);
    expect(names).toContain("master key");
    expect(names).toContain("player");
    expect(names).toContain("cell");
  });
});

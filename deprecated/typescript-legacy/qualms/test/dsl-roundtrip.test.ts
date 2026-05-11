/**
 * Round-trip tests for the DSL emitter + loader. Build a GameDefinition
 * programmatically, emit to DSL text, reload, and compare structurally.
 */

import { describe, expect, it } from "vitest";
import {
  GameDefinition,
  action,
  attachment,
  dsl,
  entitySpec,
  field,
  kind,
  parameter,
  pattern,
  relation,
  rule,
  rulebook,
  trait,
} from "../src/index.js";

const { emitDsl, loadDslText } = dsl;

function buildGameSlice(): GameDefinition {
  const def = new GameDefinition();
  // Prelude pieces — referenced by the game slice.
  def.addTrait(
    trait("Presentable", "prelude", { fields: [field("name", { type: "str", default: "" })] }),
  );
  def.addTrait(
    trait("Combatant", "prelude", { fields: [field("hp", { type: "int", default: 10 })] }),
  );
  // Game-module additions.
  def.addRelation(
    relation("Owns", "game", [parameter("owner"), parameter("owned")]),
  );
  def.addAction(action("Inspect", "game", [parameter("actor"), parameter("target")]));
  def.addRulebook(rulebook("EveryTurn", "game"));
  def.addRule(
    rule("tick", "game", "after", {
      pattern: pattern("Inspect", { actor: { type: "var", name: "a" } }),
      rulebook: "EveryTurn",
      priority: 5,
    }),
  );
  def.addKind(
    kind("Foe", "game", {
      traits: [attachment("Combatant"), attachment("Presentable")],
    }),
  );
  def.addInitialEntity(
    entitySpec("grunt", "game", {
      kind: "Foe",
      fields: { Combatant: { hp: 5 }, Presentable: { name: "Grunt" } },
      metadata: { spawned: true },
    }),
  );
  return def;
}

describe("dsl emitter: structural shapes", () => {
  it("emits a trait with fields", () => {
    const def = new GameDefinition();
    def.addTrait(
      trait("Presentable", "prelude", {
        fields: [
          field("name", { type: "str", default: "" }),
          field("hp", { type: "int" }),
        ],
      }),
    );
    const text = emitDsl(def, "prelude");
    expect(text).toContain("def trait Presentable");
    expect(text).toContain('name: str = ""');
    expect(text).toContain("hp: int");
  });

  it("emits a kind with colon trait list", () => {
    const def = new GameDefinition();
    def.addTrait(trait("Presentable", "prelude"));
    def.addTrait(trait("Relocatable", "prelude"));
    def.addKind(
      kind("Item", "prelude", {
        traits: [attachment("Presentable"), attachment("Relocatable")],
      }),
    );
    const text = emitDsl(def, "prelude");
    expect(text).toContain("def kind Item: Presentable, Relocatable");
  });

  it("emits an entity with kind + Trait.field overrides + metadata", () => {
    const def = buildGameSlice();
    const text = emitDsl(def, "game");
    expect(text).toContain("def entity grunt: Foe");
    expect(text).toContain("Combatant.hp = 5");
    expect(text).toContain('Presentable.name = "Grunt"');
    expect(text).toContain("metadata.spawned = true");
  });

  it("emits a rulebook + rule referencing it", () => {
    const def = buildGameSlice();
    const text = emitDsl(def, "game");
    expect(text).toContain("def rulebook EveryTurn");
    expect(text).toContain("def rule tick in EveryTurn");
    expect(text).toContain("phase: after");
    expect(text).toContain("priority: 5");
  });
});

describe("dsl round-trip: emit → load → equality", () => {
  it("trait + relation round-trip", () => {
    const original = new GameDefinition();
    original.addTrait(
      trait("Presentable", "prelude", {
        fields: [field("name", { type: "str", default: "" })],
      }),
    );
    original.addRelation(
      relation("Owns", "prelude", [parameter("owner"), parameter("owned")]),
    );
    const text = emitDsl(original, "prelude");

    const reloaded = new GameDefinition();
    loadDslText(reloaded, text, { module: "prelude" });

    expect(reloaded.hasTrait("Presentable")).toBe(true);
    expect(reloaded.trait("Presentable").fields.map((f) => f.id)).toEqual(["name"]);
    expect(reloaded.hasRelation("Owns")).toBe(true);
    expect(reloaded.relation("Owns").parameters.map((p) => p.id)).toEqual(["owner", "owned"]);
  });

  it("derived relation with `get` body round-trips", () => {
    const original = new GameDefinition();
    // Build a get body programmatically.
    original.addRelation(
      relation("Always", "prelude", [parameter("a")], {
        get: { type: "literal", value: true },
      }),
    );
    const text = emitDsl(original, "prelude");
    const reloaded = new GameDefinition();
    loadDslText(reloaded, text, { module: "prelude" });
    expect(reloaded.relation("Always").get).toBeDefined();
  });

  it("kind + entity round-trip with field overrides", () => {
    const def = buildGameSlice();
    const text = emitDsl(def, "game");

    // Reload requires the prelude pieces to be present first.
    const reloaded = new GameDefinition();
    loadDslText(
      reloaded,
      `
        def trait Presentable { name: str = "" };
        def trait Combatant { hp: int = 10 };
      `,
      { module: "prelude" },
    );
    loadDslText(reloaded, text, { module: "game" });

    expect(reloaded.hasKind("Foe")).toBe(true);
    expect(reloaded.kind("Foe").traits.map((t) => t.id)).toEqual([
      "Combatant",
      "Presentable",
    ]);
    expect(reloaded.hasInitialEntity("grunt")).toBe(true);
    const grunt = reloaded.initialEntity("grunt");
    expect(grunt.fields).toEqual({
      Combatant: { hp: 5 },
      Presentable: { name: "Grunt" },
    });
    expect(grunt.metadata).toMatchObject({ spawned: true });
  });

  it("rulebook + rule round-trip", () => {
    const original = new GameDefinition();
    original.addAction(action("Look", "prelude", [parameter("a")]));
    original.addRulebook(rulebook("Story", "prelude"));
    original.addRule(
      rule("noticed", "prelude", "after", {
        pattern: pattern("Look", { a: { type: "var", name: "actor" } }),
        rulebook: "Story",
        priority: 3,
      }),
    );
    const text = emitDsl(original, "prelude");

    const reloaded = new GameDefinition();
    loadDslText(reloaded, text, { module: "prelude" });

    expect(reloaded.hasRulebook("Story")).toBe(true);
    expect(reloaded.rule("noticed").rulebook).toBe("Story");
    expect(reloaded.rule("noticed").priority).toBe(3);
  });

  it("trait with nested relation/action round-trips", () => {
    const original = new GameDefinition();
    original.addTrait(
      trait("Relocatable", "prelude", {
        fields: [field("location", { type: "ref<Location>?", default: null })],
        relations: [
          relation("At", "prelude", [parameter("subject"), parameter("location")]),
        ],
        actions: [action("Move", "prelude", [parameter("subject"), parameter("destination")])],
      }),
    );
    const text = emitDsl(original, "prelude");

    const reloaded = new GameDefinition();
    loadDslText(reloaded, text, { module: "prelude" });

    expect(reloaded.hasTrait("Relocatable")).toBe(true);
    expect(reloaded.hasRelation("At")).toBe(true); // lifted out of trait
    expect(reloaded.hasAction("Move")).toBe(true);
    expect(reloaded.trait("Relocatable").fields.map((f) => f.id)).toEqual(["location"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  DuplicateDefinitionError,
  GameDefinition,
  RulesEngine,
  UnknownDefinitionError,
  action,
  attachment,
  buildEntity,
  entitySpec,
  field,
  instantiate,
  kind,
  parameter,
  pattern,
  relation,
  rule,
  rulebook,
  trait,
} from "../src/index.js";

describe("core builders", () => {
  it("parameter() flags hasDefault correctly", () => {
    expect(parameter("x").hasDefault).toBe(false);
    expect(parameter("x", { default: 42 }).hasDefault).toBe(true);
    // Explicit `undefined` default is still a default.
    expect(parameter("x", { default: undefined }).hasDefault).toBe(true);
  });

  it("field() flags hasDefault correctly", () => {
    expect(field("x").hasDefault).toBe(false);
    expect(field("x", { default: "" }).hasDefault).toBe(true);
  });

  it("trait() captures layer and defaults empty arrays", () => {
    const t = trait("Presentable", "prelude", {
      fields: [field("name", { type: "str", default: "" })],
    });
    expect(t.module).toBe("prelude");
    expect(t.id).toBe("Presentable");
    expect(t.relations).toEqual([]);
    expect(t.actions).toEqual([]);
  });
});

describe("GameDefinition (layered)", () => {
  it("registers traits and lifts contributed relations/actions/rules", () => {
    const def = new GameDefinition();
    const at = relation("At", "prelude", [parameter("subject"), parameter("location")]);
    const move = action("Move", "prelude", [parameter("subject"), parameter("destination")]);
    const lifted = trait("Relocatable", "prelude", {
      relations: [at],
      actions: [move],
    });
    def.addTrait(lifted);
    expect(def.hasTrait("Relocatable")).toBe(true);
    expect(def.hasRelation("At")).toBe(true);
    expect(def.hasAction("Move")).toBe(true);
    expect(def.relation("At").module).toBe("prelude");
    expect(def.action("Move").module).toBe("prelude");
  });

  it("throws on duplicate trait id with cross-layer context", () => {
    const def = new GameDefinition();
    def.addTrait(trait("Presentable", "prelude"));
    expect(() => def.addTrait(trait("Presentable", "game"))).toThrowError(
      DuplicateDefinitionError,
    );
  });

  it("throws on unknown lookups with informative kind", () => {
    const def = new GameDefinition();
    expect(() => def.relation("Nope")).toThrowError(UnknownDefinitionError);
    expect(() => def.relation("Nope")).toThrowError(/relation 'Nope'/);
  });

  it("filters by layer correctly", () => {
    const def = new GameDefinition();
    def.addTrait(trait("Presentable", "prelude", { fields: [field("name", { type: "str", default: "" })] }));
    def.addTrait(trait("Bonus", "game"));
    def.addRelation(relation("Custom", "session", [parameter("a")]));

    expect(def.traitsByModule("prelude").map((t) => t.id)).toEqual(["Presentable"]);
    expect(def.traitsByModule("game").map((t) => t.id)).toEqual(["Bonus"]);
    expect(def.traitsByModule("session")).toEqual([]);
    expect(def.relationsByModule("session").map((r) => r.id)).toEqual(["Custom"]);
  });

  it("preserves layer attribution on lifted relations from cross-layer traits", () => {
    const def = new GameDefinition();
    // A game-layer trait that contributes a session-layer relation explicitly.
    const r = relation("R", "session", [parameter("x")]);
    def.addTrait(trait("OddOne", "game", { relations: [r] }));
    // Trait is game; relation keeps its declared layer.
    expect(def.trait("OddOne").module).toBe("game");
    expect(def.relation("R").module).toBe("session");
  });

  it("validate() catches kind referencing unknown trait", () => {
    const def = new GameDefinition();
    def.addKind(kind("Broken", "game", { traits: [attachment("Missing")] }));
    expect(() => def.validate()).toThrowError(/unknown trait 'Missing'/);
  });

  it("validate() catches entity referencing unknown kind", () => {
    const def = new GameDefinition();
    def.addInitialEntity(entitySpec("e1", "game", { kind: "NoSuchKind" }));
    expect(() => def.validate()).toThrowError(/unknown kind 'NoSuchKind'/);
  });

  it("validate() catches initial assertion against unknown relation", () => {
    const def = new GameDefinition();
    def.addInitialAssertion({ relation: "Ghost", args: [], module: "game" });
    expect(() => def.validate()).toThrowError(/unknown relation 'Ghost'/);
  });
});

describe("buildEntity", () => {
  function presentable(): GameDefinition {
    const def = new GameDefinition();
    def.addTrait(
      trait("Presentable", "prelude", {
        fields: [
          field("name", { type: "str", default: "" }),
          field("description", { type: "str", default: "" }),
        ],
      }),
    );
    def.addKind(kind("Thing", "prelude", { traits: [attachment("Presentable")] }));
    return def;
  }

  it("instantiates trait fields with defaults", () => {
    const def = presentable();
    const e = buildEntity(def, entitySpec("rock", "game", { kind: "Thing" }));
    expect(e.id).toBe("rock");
    expect(e.module).toBe("game");
    expect(e.traits["Presentable"]?.fields["name"]).toBe("");
    expect(e.traits["Presentable"]?.fields["description"]).toBe("");
  });

  it("merges spec field overrides over kind+trait defaults", () => {
    const def = presentable();
    const e = buildEntity(
      def,
      entitySpec("rock", "game", {
        kind: "Thing",
        fields: { Presentable: { name: "Rock", description: "Heavy." } },
      }),
    );
    expect(e.traits["Presentable"]?.fields["name"]).toBe("Rock");
    expect(e.traits["Presentable"]?.fields["description"]).toBe("Heavy.");
  });

  it("merges attached trait params/fields over kind attachments of the same trait", () => {
    const def = new GameDefinition();
    def.addTrait(
      trait("Equipment", "prelude", {
        fields: [field("slot", { type: "str", default: "" })],
      }),
    );
    def.addKind(
      kind("Wearable", "prelude", {
        traits: [attachment("Equipment", { fields: { slot: "head" } })],
      }),
    );
    const e = buildEntity(
      def,
      entitySpec("hat", "game", {
        kind: "Wearable",
        traits: [attachment("Equipment", { fields: { slot: "headband" } })],
      }),
    );
    expect(e.traits["Equipment"]?.fields["slot"]).toBe("headband");
  });

  it("kind metadata default is preserved unless spec metadata overrides", () => {
    const def = presentable();
    const e1 = buildEntity(def, entitySpec("r1", "game", { kind: "Thing" }));
    expect(e1.metadata["kind"]).toBe("Thing");
    const e2 = buildEntity(
      def,
      entitySpec("r2", "game", { kind: "Thing", metadata: { kind: "Custom" } }),
    );
    expect(e2.metadata["kind"]).toBe("Custom");
  });
});

describe("instantiate + WorldState", () => {
  function bareWorld(): GameDefinition {
    const def = new GameDefinition();
    def.addTrait(
      trait("Presentable", "prelude", {
        fields: [field("name", { type: "str", default: "" })],
      }),
    );
    def.addTrait(
      trait("Relocatable", "prelude", {
        relations: [
          relation(
            "At",
            "prelude",
            [parameter("subject"), parameter("location")],
            {},
          ),
        ],
      }),
    );
    def.addKind(
      kind("Thing", "prelude", { traits: [attachment("Presentable")] }),
    );
    def.addKind(
      kind("Place", "prelude", { traits: [attachment("Presentable")] }),
    );
    def.addKind(
      kind("Mover", "prelude", {
        traits: [attachment("Presentable"), attachment("Relocatable")],
      }),
    );
    return def;
  }

  it("creates entities and applies initial assertions with layer attribution", () => {
    const def = bareWorld();
    def.addInitialEntity(entitySpec("here", "game", { kind: "Place" }));
    def.addInitialEntity(entitySpec("player", "game", { kind: "Mover" }));
    def.addInitialAssertion({
      relation: "At",
      args: ["player", "here"],
      module: "game",
    });
    const state = instantiate(def);
    expect(state.entities.size).toBe(2);
    expect(state.test("At", ["player", "here"])).toBe(true);
    expect(state.storedTuples("At")[0]?.module).toBe("game");
  });

  it("test() throws for derived relations in step 1", () => {
    const def = new GameDefinition();
    def.addRelation(relation("Visible", "prelude", [parameter("e")], { get: true }));
    const state = instantiate(def);
    expect(() => state.test("Visible", ["x"])).toThrowError(/derived/);
  });

  it("setField rejects unknown field on a trait", () => {
    const def = bareWorld();
    def.addInitialEntity(entitySpec("rock", "game", { kind: "Thing" }));
    const state = instantiate(def);
    expect(() => state.setField("rock", "Presentable", "nope", "x")).toThrowError(
      /no field 'nope'/,
    );
  });

  it("setField rejects unknown trait on an entity", () => {
    const def = bareWorld();
    def.addInitialEntity(entitySpec("rock", "game", { kind: "Thing" }));
    const state = instantiate(def);
    expect(() => state.setField("rock", "Relocatable", "location", "x")).toThrowError(
      /lacks trait 'Relocatable'/,
    );
  });

  it("grantTrait adds an attachment at runtime", () => {
    const def = bareWorld();
    def.addInitialEntity(entitySpec("rock", "game", { kind: "Thing" }));
    const state = instantiate(def);
    expect(state.hasTrait("rock", "Relocatable")).toBe(false);
    state.grantTrait("rock", attachment("Relocatable"));
    expect(state.hasTrait("rock", "Relocatable")).toBe(true);
  });

  it("retract removes a stored relation", () => {
    const def = bareWorld();
    def.addInitialEntity(entitySpec("here", "game", { kind: "Place" }));
    def.addInitialEntity(entitySpec("player", "game", { kind: "Mover" }));
    def.addInitialAssertion({
      relation: "At",
      args: ["player", "here"],
      module: "game",
    });
    const state = instantiate(def);
    state.retractRelation("At", ["player", "here"]);
    expect(state.test("At", ["player", "here"])).toBe(false);
  });

  it("allocate produces unique ids per prefix", () => {
    const def = bareWorld();
    const state = instantiate(def);
    expect(state.allocate("npc")).toBe("npc-1");
    expect(state.allocate("npc")).toBe("npc-2");
    expect(state.allocate("item")).toBe("item-1");
  });
});

describe("RulesEngine (stub)", () => {
  it("returns unimplemented for known actions", () => {
    const def = new GameDefinition();
    def.addAction(action("Examine", "prelude", [parameter("target")]));
    const engine = new RulesEngine(def);
    const state = instantiate(def);
    const result = engine.attempt(state, { actionId: "Examine", args: { target: "x" } });
    expect(result.status).toBe("unimplemented");
  });

  it("throws (via UnknownDefinitionError) for an unknown action", () => {
    const def = new GameDefinition();
    const engine = new RulesEngine(def);
    const state = instantiate(def);
    expect(() => engine.attempt(state, { actionId: "Nope", args: {} })).toThrowError(
      UnknownDefinitionError,
    );
  });
});

describe("layer attribution survives merge", () => {
  it("a single GameDefinition can host all three layers and report them correctly", () => {
    const def = new GameDefinition();
    def.addTrait(trait("Presentable", "prelude", { fields: [field("name", { type: "str", default: "" })] }));
    def.addTrait(trait("StoryTag", "game"));
    def.addRelation(relation("PlayerSpawn", "session", [parameter("a")]));

    expect(def.traitsByModule("prelude").map((t) => t.id)).toEqual(["Presentable"]);
    expect(def.traitsByModule("game").map((t) => t.id)).toEqual(["StoryTag"]);
    expect(def.relationsByModule("session").map((r) => r.id)).toEqual(["PlayerSpawn"]);
    // Merged view sees all of them.
    expect([...def.traits.keys()].sort()).toEqual(["Presentable", "StoryTag"]);
    expect([...def.relations.keys()]).toContain("PlayerSpawn");
  });
});

describe("rule registration", () => {
  it("dedupes contributed rules by id", () => {
    const def = new GameDefinition();
    const r = rule("noop", "prelude", "after", { pattern: pattern("X") });
    def.addRule(r);
    // A trait that re-declares the same rule id silently no-ops on the second add.
    def.addRule(r);
    expect(def.rules.length).toBe(1);
  });
});

describe("rulebook registration", () => {
  it("adds, looks up, and reports by layer", () => {
    const def = new GameDefinition();
    def.addRulebook(rulebook("EveryTurn", "prelude"));
    expect(def.hasRulebook("EveryTurn")).toBe(true);
    expect(def.rulebook("EveryTurn").module).toBe("prelude");
    expect(def.rulebooksByModule("prelude").map((r) => r.id)).toEqual(["EveryTurn"]);
  });

  it("rejects duplicate ids", () => {
    const def = new GameDefinition();
    def.addRulebook(rulebook("R", "prelude"));
    expect(() => def.addRulebook(rulebook("R", "game"))).toThrowError(
      DuplicateDefinitionError,
    );
  });

  it("validate() rejects rule referencing missing rulebook", () => {
    const def = new GameDefinition();
    def.addAction(action("X", "prelude", []));
    def.addRule(
      rule("orphan", "prelude", "after", {
        pattern: pattern("X"),
        rulebook: "NoSuchBook",
      }),
    );
    expect(() => def.validate()).toThrowError(/unknown rulebook/);
  });

  it("validate() passes when rulebook reference resolves", () => {
    const def = new GameDefinition();
    def.addAction(action("X", "prelude", []));
    def.addRulebook(rulebook("Book", "prelude"));
    def.addRule(
      rule("inbook", "prelude", "after", {
        pattern: pattern("X"),
        rulebook: "Book",
      }),
    );
    expect(() => def.validate()).not.toThrow();
  });
});

describe("GameDefinition removers", () => {
  it("removeTrait drops the trait and its lifted relations/actions/rules", () => {
    const def = new GameDefinition();
    def.addTrait(
      trait("Relocatable", "prelude", {
        relations: [relation("At", "prelude", [parameter("a")])],
        actions: [action("Move", "prelude", [parameter("a")])],
      }),
    );
    expect(def.hasRelation("At")).toBe(true);
    def.removeTrait("Relocatable");
    expect(def.hasTrait("Relocatable")).toBe(false);
    expect(def.hasRelation("At")).toBe(false);
    expect(def.hasAction("Move")).toBe(false);
  });

  it("removeRelation / removeAction / removeKind", () => {
    const def = new GameDefinition();
    def.addRelation(relation("R", "prelude", []));
    def.addAction(action("A", "prelude", []));
    def.addKind(kind("K", "prelude"));
    def.removeRelation("R");
    def.removeAction("A");
    def.removeKind("K");
    expect(def.hasRelation("R")).toBe(false);
    expect(def.hasAction("A")).toBe(false);
    expect(def.hasKind("K")).toBe(false);
  });

  it("removeRulebook", () => {
    const def = new GameDefinition();
    def.addRulebook(rulebook("Book", "prelude"));
    def.removeRulebook("Book");
    expect(def.hasRulebook("Book")).toBe(false);
  });

  it("removeRule + removeInitialEntity", () => {
    const def = new GameDefinition();
    def.addAction(action("A", "prelude", []));
    def.addRule(rule("r1", "prelude", "after", { pattern: pattern("A") }));
    def.addInitialEntity(entitySpec("e1", "game"));
    def.removeRule("r1");
    def.removeInitialEntity("e1");
    expect(def.hasRule("r1")).toBe(false);
    expect(def.hasInitialEntity("e1")).toBe(false);
  });

  it("each remover throws UnknownDefinitionError on missing id", () => {
    const def = new GameDefinition();
    expect(() => def.removeTrait("nope")).toThrowError(UnknownDefinitionError);
    expect(() => def.removeRelation("nope")).toThrowError(UnknownDefinitionError);
    expect(() => def.removeAction("nope")).toThrowError(UnknownDefinitionError);
    expect(() => def.removeKind("nope")).toThrowError(UnknownDefinitionError);
    expect(() => def.removeRulebook("nope")).toThrowError(UnknownDefinitionError);
    expect(() => def.removeRule("nope")).toThrowError(UnknownDefinitionError);
    expect(() => def.removeInitialEntity("nope")).toThrowError(UnknownDefinitionError);
  });
});

describe("GameDefinition.clone()", () => {
  it("produces a deep copy with no shared Map refs", () => {
    const def = new GameDefinition();
    def.addTrait(trait("Presentable", "prelude", { fields: [field("name", { default: "" })] }));
    def.addRelation(relation("R", "prelude", []));
    def.addInitialEntity(entitySpec("e1", "game"));

    const copy = def.clone();
    // Mutate the original.
    def.removeTrait("Presentable");

    // Clone is unaffected.
    expect(copy.hasTrait("Presentable")).toBe(true);
    expect(copy.hasRelation("R")).toBe(true);
    expect(copy.hasInitialEntity("e1")).toBe(true);
    expect(def.hasTrait("Presentable")).toBe(false);
  });

  it("clones rulebooks and rule rulebook references", () => {
    const def = new GameDefinition();
    def.addAction(action("A", "prelude", []));
    def.addRulebook(rulebook("Book", "prelude"));
    def.addRule(
      rule("r1", "prelude", "after", { pattern: pattern("A"), rulebook: "Book" }),
    );
    const copy = def.clone();
    expect(copy.hasRulebook("Book")).toBe(true);
    expect(copy.rule("r1").rulebook).toBe("Book");
    expect(() => copy.validate()).not.toThrow();
  });
});

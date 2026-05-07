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
    expect(t.layer).toBe("prelude");
    expect(t.id).toBe("Presentable");
    expect(t.relations).toEqual([]);
    expect(t.actions).toEqual([]);
  });
});

describe("GameDefinition (layered)", () => {
  it("registers traits and lifts contributed relations/actions/rules", () => {
    const def = new GameDefinition();
    const at = relation("At", "prelude", [parameter("subject"), parameter("location")], {
      persistence: "current",
    });
    const move = action("Move", "prelude", [parameter("subject"), parameter("destination")]);
    const lifted = trait("Relocatable", "prelude", {
      relations: [at],
      actions: [move],
    });
    def.addTrait(lifted);
    expect(def.hasTrait("Relocatable")).toBe(true);
    expect(def.hasRelation("At")).toBe(true);
    expect(def.hasAction("Move")).toBe(true);
    expect(def.relation("At").layer).toBe("prelude");
    expect(def.action("Move").layer).toBe("prelude");
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
    def.addRelation(relation("Custom", "session", [parameter("a")], { persistence: "current" }));

    expect(def.traitsByLayer("prelude").map((t) => t.id)).toEqual(["Presentable"]);
    expect(def.traitsByLayer("game").map((t) => t.id)).toEqual(["Bonus"]);
    expect(def.traitsByLayer("session")).toEqual([]);
    expect(def.relationsByLayer("session").map((r) => r.id)).toEqual(["Custom"]);
  });

  it("preserves layer attribution on lifted relations from cross-layer traits", () => {
    const def = new GameDefinition();
    // A game-layer trait that contributes a session-layer relation explicitly.
    const r = relation("R", "session", [parameter("x")], { persistence: "current" });
    def.addTrait(trait("OddOne", "game", { relations: [r] }));
    // Trait is game; relation keeps its declared layer.
    expect(def.trait("OddOne").layer).toBe("game");
    expect(def.relation("R").layer).toBe("session");
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
    def.addInitialAssertion({ relation: "Ghost", args: [], layer: "game" });
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
    expect(e.layer).toBe("game");
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
            { persistence: "current" },
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
      layer: "game",
    });
    const state = instantiate(def);
    expect(state.entities.size).toBe(2);
    expect(state.test("At", ["player", "here"])).toBe(true);
    expect(state.storedTuples("At")[0]?.layer).toBe("game");
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
      layer: "game",
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
    def.addRelation(relation("PlayerSpawn", "session", [parameter("a")], { persistence: "current" }));

    expect(def.traitsByLayer("prelude").map((t) => t.id)).toEqual(["Presentable"]);
    expect(def.traitsByLayer("game").map((t) => t.id)).toEqual(["StoryTag"]);
    expect(def.relationsByLayer("session").map((r) => r.id)).toEqual(["PlayerSpawn"]);
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

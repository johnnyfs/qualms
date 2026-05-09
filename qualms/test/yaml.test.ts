import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GameDefinition,
  action,
  attachment,
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
  yaml,
} from "../src/index.js";
import {
  makeContext,
  parseQuery,
  runQuery,
} from "../src/query/index.js";

const { emitDefinition, emitToObject, loadFileIntoDefinition, loadParsed, loadYamlIntoDefinition, translatePredicate } = yaml;

const __filename = fileURLToPath(import.meta.url);
const PRELUDE_PATH = resolve(__filename, "../../prelude/core.qualms.yaml");

// ──────── Loader unit tests (per construct) ────────

describe("yaml predicate translator", () => {
  it("primitives become literal expressions", () => {
    expect(translatePredicate(true)).toEqual({ type: "literal", value: true });
    expect(translatePredicate(false)).toEqual({ type: "literal", value: false });
  });

  it("eq with vars produces equality AST", () => {
    expect(
      translatePredicate({
        eq: [{ var: "a" }, { var: "b" }],
      }),
    ).toEqual({
      type: "equal",
      left: { type: "var", name: "a" },
      right: { type: "var", name: "b" },
    });
  });

  it("any/all fold over arms", () => {
    const any = translatePredicate({ any: [true, false, true] });
    expect(any.type).toBe("or");
    const all = translatePredicate({ all: [true, true] });
    expect(all.type).toBe("and");
  });

  it("relation form", () => {
    expect(
      translatePredicate({
        relation: { id: "At", args: [{ var: "x" }, { var: "y" }] },
      }),
    ).toEqual({
      type: "relation",
      relation: "At",
      args: [
        { type: "var", name: "x" },
        { type: "var", name: "y" },
      ],
    });
  });

  it("has_trait becomes traitOf", () => {
    expect(
      translatePredicate({
        has_trait: { entity: { var: "a" }, trait: "Item" },
      }),
    ).toEqual({
      type: "traitOf",
      entity: { type: "var", name: "a" },
      filter: { name: "Item" },
    });
  });

  it("field-access term produces field AST", () => {
    expect(
      translatePredicate({
        eq: [
          { field: { entity: { var: "x" }, trait: "Presentable", field: "name" } },
          "Foo",
        ],
      }),
    ).toEqual({
      type: "equal",
      left: {
        type: "field",
        entity: { type: "var", name: "x" },
        trait: "Presentable",
        field: "name",
      },
      right: { type: "value", value: "Foo" },
    });
  });

  it("rejects multi-key predicate objects", () => {
    expect(() => translatePredicate({ any: [], all: [] })).toThrowError(/single-key/);
  });

  it("rejects unknown operator", () => {
    expect(() => translatePredicate({ some_xor: [] })).toThrowError(/unknown predicate operator/);
  });
});

describe("yaml loader: per-construct", () => {
  function load(input: string): GameDefinition {
    const def = new GameDefinition();
    loadYamlIntoDefinition(def, input, { layer: "prelude" });
    return def;
  }

  it("loads a trait with fields", () => {
    const def = load(`
qualms: "0.1"
id: t
definitions:
  traits:
    - id: Presentable
      fields:
        - id: name
          type: str
          default: ""
`);
    expect(def.hasTrait("Presentable")).toBe(true);
    const t = def.trait("Presentable");
    expect(t.fields).toHaveLength(1);
    expect(t.fields[0]?.id).toBe("name");
    expect(t.fields[0]?.hasDefault).toBe(true);
    expect(t.fields[0]?.default).toBe("");
    expect(t.layer).toBe("prelude");
  });

  it("lifts trait-owned relations into the merged map", () => {
    const def = load(`
qualms: "0.1"
id: t
definitions:
  traits:
    - id: Location
      relations:
        - id: Path
          params:
            - id: source
            - id: target
`);
    expect(def.hasRelation("Path")).toBe(true);
    // Stored: no `get` body present.
    expect(def.relation("Path").get).toBeUndefined();
  });

  it("loads a derived relation with predicate body", () => {
    const def = load(`
qualms: "0.1"
id: t
definitions:
  traits:
    - id: Presentable
      fields:
        - id: name
          type: str
          default: ""
  relations:
    - id: Named
      params:
        - id: entity
        - id: name
      get:
        eq:
          - field:
              entity: { var: entity }
              trait: Presentable
              field: name
          - { var: name }
`);
    const r = def.relation("Named");
    expect(r.get).toBeDefined();
    // The body is a query AST equality node.
    expect((r.get as { type: string }).type).toBe("equal");
  });

  it("loads kinds with attachments", () => {
    const def = load(`
qualms: "0.1"
id: t
definitions:
  traits:
    - id: Presentable
    - id: Location
  kinds:
    - id: Place
      traits:
        - id: Presentable
        - id: Location
`);
    const place = def.kind("Place");
    expect(place.traits.map((a) => a.id)).toEqual(["Presentable", "Location"]);
  });

  it("loads rulebooks with nested rules", () => {
    const def = load(`
qualms: "0.1"
id: t
definitions:
  actions:
    - id: Enter
      params:
        - id: actor
        - id: destination
  relations:
    - id: Visited
      params:
        - id: actor
        - id: location
  rulebooks:
    - id: story-memory
      rules:
        - id: remember-visited-location
          phase: after
          match:
            action: Enter
            args:
              actor: { bind: actor }
              destination: { bind: destination }
          effects:
            - assert:
                relation: Visited
                args:
                  - { var: actor }
                  - { var: destination }
`);
    expect(def.rules).toHaveLength(1);
    expect(def.rules[0]?.phase).toBe("after");
    expect(def.rules[0]?.pattern.action).toBe("Enter");
  });

  it("loads top-level entities/assertions/facts under story.* with layer attribution", () => {
    const def = load(`
qualms: "0.1"
id: t
definitions:
  traits:
    - id: Presentable
      fields:
        - id: name
          type: str
          default: ""
  kinds:
    - id: Thing
      traits:
        - id: Presentable
  relations:
    - id: At
      params:
        - id: subject
        - id: location
story:
  entities:
    - id: rock
      kind: Thing
    - id: place
      kind: Thing
  assertions:
    - relation: At
      args: ["rock", "place"]
  start:
    actor: rock
`);
    expect(def.initialEntities).toHaveLength(2);
    expect(def.initialEntities[0]?.layer).toBe("prelude");
    expect(def.initialAssertions).toHaveLength(1);
    expect(def.metadataFor("prelude")["start.actor"]).toBe("rock");
  });

  it("rejects malformed YAML root", () => {
    expect(() =>
      loadYamlIntoDefinition(new GameDefinition(), "- not a mapping", { layer: "prelude" }),
    ).toThrowError(/root must be a mapping/);
  });

  it("rejects any persistence key (the field has been collapsed)", () => {
    expect(() =>
      loadYamlIntoDefinition(
        new GameDefinition(),
        `qualms: "0.1"
id: t
definitions:
  relations:
    - id: Bad
      persistence: current
      params: []`,
        { layer: "prelude" },
      ),
    ).toThrowError(/persistence/);
  });
});

// ──────── Integration: load migrated prelude and run DSL queries ────────

describe("migrated core prelude (qualms/prelude/core.qualms.yaml)", () => {
  function loaded(): { def: GameDefinition; state: ReturnType<typeof instantiate> } {
    const def = new GameDefinition();
    loadFileIntoDefinition(def, PRELUDE_PATH, "prelude");
    const state = instantiate(def);
    return { def, state };
  }

  it("loads without errors", () => {
    expect(() => loaded()).not.toThrow();
  });

  it("expected traits are present in the prelude layer", () => {
    const { def, state } = loaded();
    const ctx = makeContext(def, { state });
    const result = runQuery(parseQuery("{ t : Trait@prelude | true }"), ctx);
    const ids = new Set(result.rows.map((r) => r["t"]));
    expect(ids).toEqual(
      new Set([
        "Presentable",
        "Actor",
        "Location",
        "Relocatable",
        "Scope",
        "Container",
        "Portable",
        "Usable",
        "Equipment",
        "Ownable",
      ]),
    );
  });

  it("Item kind is present and uses Presentable + Relocatable", () => {
    const { def, state } = loaded();
    const ctx = makeContext(def, { state });
    const result = runQuery(parseQuery('{ t | uses("Item", t) }'), ctx);
    const ts = new Set(result.rows.map((r) => r["t"]));
    expect(ts).toEqual(new Set(["Presentable", "Relocatable"]));
  });

  it("IsPlayer relation exists", () => {
    const { def, state } = loaded();
    const ctx = makeContext(def, { state });
    const yes = runQuery(parseQuery('?- exists r : Relation. r.id = "IsPlayer"'), ctx);
    expect(yes.count).toBe(1);
  });

  it("SequenceComplete is purged", () => {
    const { def, state } = loaded();
    const ctx = makeContext(def, { state });
    const yes = runQuery(parseQuery('?- exists r : Relation. r.id = "SequenceComplete"'), ctx);
    expect(yes.count).toBe(0);
  });

  it("kinds-with-Presentable matches the four core authoring shapes", () => {
    const { def, state } = loaded();
    const ctx = makeContext(def, { state });
    const result = runQuery(parseQuery('{ k : Kind | uses(k, "Presentable") }'), ctx);
    const ks = new Set(result.rows.map((r) => r["k"]));
    expect(ks).toEqual(new Set(["Thing", "Place", "Person", "Item"]));
  });

  it("Can-prefixed prelude relations match /^Can/", () => {
    const { def, state } = loaded();
    const ctx = makeContext(def, { state });
    const result = runQuery(
      parseQuery("{ r : Relation@prelude | r.id =~ /^Can/ }"),
      ctx,
    );
    const rs = new Set(result.rows.map((r) => r["r"]));
    expect(rs).toEqual(new Set(["CanTouch", "CanSee"]));
  });

  it("post-scrub: no Visited / Aboard / core-memory in the prelude", () => {
    const { def } = loaded();
    expect(def.hasRelation("Visited")).toBe(false);
    expect(def.hasRelation("Aboard")).toBe(false);
    expect(def.hasRulebook("core-memory")).toBe(false);
    expect(def.rules).toHaveLength(0);
  });

  it("CarriedBy derived relation has a translated body", () => {
    const { def } = loaded();
    const cb = def.relation("CarriedBy");
    expect(cb.get).toBeDefined();
    expect((cb.get as { type: string }).type).toBe("relation"); // it derives from At
  });

  it("instantiate succeeds (no entities yet, but state is constructible)", () => {
    const { state } = loaded();
    expect(state.entities.size).toBe(0);
  });
});

// ──────── Emitter round-trip tests ────────

describe("yaml emitter: round-trip of game-layer slice", () => {
  function buildGameDef(): GameDefinition {
    const def = new GameDefinition();
    // Prelude pieces — won't be emitted at game scope.
    def.addTrait(trait("Presentable", "prelude", { fields: [field("name", { default: "" })] }));
    def.addTrait(trait("Item", "prelude"));
    // Game-layer additions.
    def.addTrait(
      trait("Combatant", "game", {
        fields: [field("hp", { default: 10 }), field("dmg", { default: 1 })],
      }),
    );
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
        fields: { Presentable: { name: "Grunt" } },
      }),
    );
    def.addInitialEntity(
      entitySpec("grunt", "game", {
        kind: "Foe",
        fields: { Combatant: { hp: 5 } },
        metadata: { spawned: true },
      }),
    );
    def.addInitialAssertion({ relation: "Owns", args: ["grunt", "stick"], layer: "game" });
    return def;
  }

  it("emit + reload reproduces the game-layer slice", () => {
    const original = buildGameDef();
    const emitted = emitToObject(original, "game");

    // Reload into a fresh def, with the prelude pre-loaded so refs resolve.
    const reloaded = new GameDefinition();
    reloaded.addTrait(trait("Presentable", "prelude", { fields: [field("name", { default: "" })] }));
    reloaded.addTrait(trait("Item", "prelude"));
    loadParsed(reloaded, emitted, { layer: "game" });

    // Trait round-trips with its fields.
    expect(reloaded.hasTrait("Combatant")).toBe(true);
    expect(reloaded.trait("Combatant").layer).toBe("game");
    expect(reloaded.trait("Combatant").fields.map((f) => f.id)).toEqual(["hp", "dmg"]);

    // Relation, action, rulebook.
    expect(reloaded.hasRelation("Owns")).toBe(true);
    expect(reloaded.relation("Owns").get).toBeUndefined(); // stored
    expect(reloaded.action("Inspect").parameters.map((p) => p.id)).toEqual(["actor", "target"]);
    expect(reloaded.hasRulebook("EveryTurn")).toBe(true);

    // Rule with rulebook membership.
    const tick = reloaded.rules.find((r) => r.id === "tick");
    expect(tick).toBeDefined();
    expect(tick!.phase).toBe("after");
    expect(tick!.priority).toBe(5);

    // Kind, entity, assertion.
    expect(reloaded.kind("Foe").traits.map((t) => t.id)).toEqual(["Combatant", "Presentable"]);
    expect(reloaded.kind("Foe").fields).toEqual({ Presentable: { name: "Grunt" } });
    const grunt = reloaded.initialEntity("grunt");
    expect(grunt.kind).toBe("Foe");
    expect(grunt.fields).toEqual({ Combatant: { hp: 5 } });
    expect(grunt.metadata).toEqual({ spawned: true });
    expect(reloaded.initialAssertions.find((a) => a.relation === "Owns")).toBeDefined();
  });

  it("emitDefinition produces a YAML string the loader accepts", () => {
    const original = buildGameDef();
    const yamlText = emitDefinition(original, "game");
    expect(typeof yamlText).toBe("string");
    expect(yamlText.length).toBeGreaterThan(0);

    const reloaded = new GameDefinition();
    reloaded.addTrait(trait("Presentable", "prelude", { fields: [field("name", { default: "" })] }));
    reloaded.addTrait(trait("Item", "prelude"));
    loadYamlIntoDefinition(reloaded, yamlText, { layer: "game" });
    expect(reloaded.hasKind("Foe")).toBe(true);
  });

  it("emits an empty document for a layer with no contents", () => {
    const def = new GameDefinition();
    def.addTrait(trait("OnlyPrelude", "prelude"));
    expect(emitToObject(def, "game")).toEqual({});
  });

  it("predicate inverter handles and/or/not/eq/relation/has_trait round-trip", () => {
    const expr: import("../src/query/ast.js").Expression = {
      type: "and",
      left: {
        type: "or",
        left: { type: "equal", left: { type: "var", name: "a" }, right: { type: "value", value: 1 } },
        right: { type: "not", operand: {
          type: "relation",
          relation: "R",
          args: [{ type: "var", name: "x" }],
        } },
      },
      right: {
        type: "traitOf",
        entity: { type: "var", name: "t" },
        filter: { name: "Presentable" },
      },
    };
    const yamlPredicate = yaml.emitPredicate(expr);
    const reloaded = translatePredicate(yamlPredicate);
    expect(reloaded).toEqual(expr);
  });
});

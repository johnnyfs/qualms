import { describe, expect, it } from "vitest";
import {
  GameDefinition,
  action,
  attachment,
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
import { mutation } from "../src/index.js";
import { parseStatement } from "../src/query/parser.js";
import type { MutationStatement } from "../src/query/ast.js";

const { Transaction, MutationError, applyMutation } = mutation;

function buildBaseDef(): GameDefinition {
  const def = new GameDefinition();
  def.addTrait(
    trait("Presentable", "prelude", { fields: [field("name", { type: "str", default: "" })] }),
  );
  def.addTrait(trait("Item", "prelude"));
  def.addTrait(
    trait("Combatant", "prelude", { fields: [field("hp", { default: 10 })] }),
  );
  def.addRelation(
    relation("Owns", "prelude", [parameter("a"), parameter("b")]),
  );
  def.addRelation(
    relation(
      "Derived",
      "prelude",
      [parameter("a"), parameter("b")],
      { get: { type: "literal", value: true } },
    ),
  );
  def.addAction(action("Move", "prelude", [parameter("a")]));
  def.addRulebook(rulebook("EveryTurn", "prelude"));
  def.addKind(
    kind("Foe", "prelude", {
      traits: [attachment("Combatant"), attachment("Presentable")],
    }),
  );
  return def;
}

function freshTx(module: "game" | "session", def: GameDefinition) {
  const state = instantiate(def);
  return {
    def,
    state,
    tx: Transaction.begin({ id: "tx-1", module, def, state }),
  };
}

function parseMutation(input: string): MutationStatement {
  const stmt = parseStatement(input);
  if (stmt.kind !== "mutation") throw new Error(`expected mutation, got ${stmt.kind}`);
  return stmt.mutation;
}

describe("mutation executor: assert / retract", () => {
  it("assert lands on a stored relation at the transaction's layer (session scope)", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(parseMutation('assert Owns("a", "b")'), tx, def, state);
    expect(state.test("Owns", ["a", "b"])).toBe(true);
    // Layer attribution: assertion records the session layer.
    expect(def.initialAssertions.some((a) => a.relation === "Owns" && a.module === "session")).toBe(
      true,
    );
  });

  it("retract removes an asserted tuple", () => {
    const { def, state, tx } = freshTx("game", buildBaseDef());
    applyMutation(parseMutation('assert Owns("a", "b")'), tx, def, state);
    applyMutation(parseMutation('retract Owns("a", "b")'), tx, def, state);
    expect(state.test("Owns", ["a", "b"])).toBe(false);
  });

  it("rejects assert on a derived relation", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    expect(() =>
      applyMutation(parseMutation('assert Derived("a", "b")'), tx, def, state),
    ).toThrowError(MutationError);
  });

  it("rejects assert on an unknown relation", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    expect(() =>
      applyMutation(parseMutation('assert NoSuchRel("a")'), tx, def, state),
    ).toThrowError(MutationError);
  });
});

describe("mutation executor: def trait / relation / action / kind", () => {
  it("def trait adds a trait at the tx module", () => {
    const { def, state, tx } = freshTx("game", buildBaseDef());
    applyMutation(
      parseMutation("def trait NewTrait { x: int = 0 }"),
      tx,
      def,
      state,
    );
    expect(def.hasTrait("NewTrait")).toBe(true);
    expect(def.trait("NewTrait").module).toBe("game");
    expect(def.trait("NewTrait").fields.map((f) => f.id)).toEqual(["x"]);
  });

  it("def relation lands at the tx layer (session)", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(parseMutation("def relation Owes(a, b) {}"), tx, def, state);
    expect(def.relation("Owes").module).toBe("session");
    // Stored: no `get` body present.
    expect(def.relation("Owes").get).toBeUndefined();
  });

  it("def action lands at tx layer", () => {
    const { def, state, tx } = freshTx("game", buildBaseDef());
    applyMutation(parseMutation("def action Look(actor) {}"), tx, def, state);
    expect(def.action("Look").module).toBe("game");
  });

  it("def kind validates trait references", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    expect(() =>
      applyMutation(
        parseMutation("def kind Bad: DoesNotExist"),
        tx,
        def,
        state,
      ),
    ).toThrowError(MutationError);
  });

  it("def kind succeeds with known traits", () => {
    const { def, state, tx } = freshTx("game", buildBaseDef());
    applyMutation(
      parseMutation("def kind Mob: Presentable, Combatant"),
      tx,
      def,
      state,
    );
    expect(def.kind("Mob").module).toBe("game");
    expect(def.kind("Mob").traits.map((t) => t.id)).toEqual(["Presentable", "Combatant"]);
  });
});

describe("mutation executor: def rule / rulebook", () => {
  it("def rulebook adds a rulebook", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(parseMutation("def rulebook PerSession {}"), tx, def, state);
    expect(def.hasRulebook("PerSession")).toBe(true);
    expect(def.rulebook("PerSession").module).toBe("session");
  });

  it("def rule succeeds when rulebook exists", () => {
    const { def, state, tx } = freshTx("game", buildBaseDef());
    applyMutation(
      parseMutation("def rule Tick in EveryTurn { phase: after; match: Move(a: x) }"),
      tx,
      def,
      state,
    );
    const r = def.rules.find((r) => r.id === "Tick");
    expect(r).toBeDefined();
    expect(r!.rulebook).toBe("EveryTurn");
    expect(r!.module).toBe("game");
  });

  it("def rule fails when rulebook is missing", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    expect(() =>
      applyMutation(
        parseMutation(
          "def rule Orphan in NoSuchBook { phase: before; match: Move(a: x) }",
        ),
        tx,
        def,
        state,
      ),
    ).toThrowError(MutationError);
  });
});

describe("mutation executor: def entity", () => {
  it("def entity materializes immediately into WorldState", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(
      parseMutation('def entity grunt: Foe { Presentable.name = "Grunt" }'),
      tx,
      def,
      state,
    );
    expect(def.hasInitialEntity("grunt")).toBe(true);
    expect(state.hasEntity("grunt")).toBe(true);
    expect(state.entity("grunt").traits["Presentable"]?.fields["name"]).toBe("Grunt");
    expect(state.entity("grunt").traits["Combatant"]).toBeDefined();
    expect(def.initialEntity("grunt").module).toBe("session");
  });

  it("def entity without kind, with traits", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(
      parseMutation("def entity ghost { trait Presentable }"),
      tx,
      def,
      state,
    );
    expect(state.entity("ghost").traits["Presentable"]).toBeDefined();
  });

  it("rejects duplicate entity id", () => {
    const { def, state, tx } = freshTx("game", buildBaseDef());
    applyMutation(parseMutation("def entity x: Foe"), tx, def, state);
    expect(() =>
      applyMutation(parseMutation("def entity x: Foe"), tx, def, state),
    ).toThrowError(MutationError);
  });
});

describe("mutation executor: field assign", () => {
  it("assigns a field on an entity", () => {
    const { def, state, tx } = freshTx("game", buildBaseDef());
    applyMutation(parseMutation("def entity x: Foe"), tx, def, state);
    applyMutation(parseMutation('x.Presentable.name := "Renamed"'), tx, def, state);
    expect(state.entity("x").traits["Presentable"]?.fields["name"]).toBe("Renamed");
  });

  it("auto-resolves trait when unambiguous", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(parseMutation("def entity x: Foe"), tx, def, state);
    applyMutation(parseMutation("x.hp := 7"), tx, def, state);
    expect(state.entity("x").traits["Combatant"]?.fields["hp"]).toBe(7);
  });

  it("rejects when trait/field unknown", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(parseMutation("def entity x: Foe"), tx, def, state);
    expect(() =>
      applyMutation(parseMutation("x.Combatant.bogus := 1"), tx, def, state),
    ).toThrowError(MutationError);
  });
});

describe("mutation executor: undef", () => {
  it("undef trait at session layer succeeds when nothing references it", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(parseMutation("def trait Tag {}"), tx, def, state);
    applyMutation(parseMutation("undef trait Tag"), tx, def, state);
    expect(def.hasTrait("Tag")).toBe(false);
  });

  it("undef rejects prelude-defined trait", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    expect(() =>
      applyMutation(parseMutation("undef trait Presentable"), tx, def, state),
    ).toThrowError(MutationError);
  });

  it("undef rejects when something references the target", () => {
    const { def, state, tx } = freshTx("game", buildBaseDef());
    applyMutation(parseMutation("def trait NewTrait {}"), tx, def, state);
    applyMutation(parseMutation("def kind UsesIt: NewTrait"), tx, def, state);
    expect(() =>
      applyMutation(parseMutation("undef trait NewTrait"), tx, def, state),
    ).toThrowError(MutationError);
  });

  it("undef entity removes from def and state", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(parseMutation("def entity x: Foe"), tx, def, state);
    applyMutation(parseMutation("undef entity x"), tx, def, state);
    expect(def.hasInitialEntity("x")).toBe(false);
    expect(state.hasEntity("x")).toBe(false);
  });

  it("undef rulebook rejects when rules still reference it", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(parseMutation("def rulebook RB {}"), tx, def, state);
    applyMutation(
      parseMutation("def rule R in RB { phase: after; match: Move(a: x) }"),
      tx,
      def,
      state,
    );
    expect(() =>
      applyMutation(parseMutation("undef rulebook RB"), tx, def, state),
    ).toThrowError(MutationError);
  });
});

describe("mutation executor: snapshots and rollback", () => {
  it("the snapshot stays unchanged as mutations apply", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(parseMutation("def trait X {}"), tx, def, state);
    expect(tx.defSnapshot.hasTrait("X")).toBe(false); // snapshot was pre-mutation
    expect(def.hasTrait("X")).toBe(true);
  });

  it("rollback restores both def and state", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(parseMutation("def trait X {}"), tx, def, state);
    applyMutation(parseMutation('def entity e1: Foe { Presentable.name = "x" }'), tx, def, state);
    const restored = Transaction.rollback(tx);
    expect(restored.def.hasTrait("X")).toBe(false);
    expect(restored.state.hasEntity("e1")).toBe(false);
  });

  it("applied log accumulates in order", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    applyMutation(parseMutation("def trait A {}"), tx, def, state);
    applyMutation(parseMutation("def trait B {}"), tx, def, state);
    expect(tx.applied.map((m) => m.type)).toEqual(["defTrait", "defTrait"]);
  });
});

describe("mutation executor: layer mapping", () => {
  it("story scope → game layer", () => {
    const { def, state, tx } = freshTx("game", buildBaseDef());
    expect(tx.module).toBe("game");
    applyMutation(parseMutation("def trait X {}"), tx, def, state);
    expect(def.trait("X").module).toBe("game");
  });

  it("session scope → session layer", () => {
    const { def, state, tx } = freshTx("session", buildBaseDef());
    expect(tx.module).toBe("session");
    applyMutation(parseMutation("def trait X {}"), tx, def, state);
    expect(def.trait("X").module).toBe("session");
  });
});

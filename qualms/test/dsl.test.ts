/**
 * DSL v2 parser tests. These exercise the v2 syntax — brace bodies with `;`
 * separators, direct field declarations in trait bodies, colon-separated kind
 * trait lists, entity bodies with `=` overrides and `trait Foo;` grants, and
 * the new top-level `query`/`exists`/`show` statement verbs.
 *
 * Authored before the parser rewrite (3b); failing here is expected until
 * 3b lands. Once green, the v1 parser tests in `parser.test.ts` are pruned to
 * just the still-supported forms (named predicate + expression sub-grammar).
 */

import { describe, expect, it } from "vitest";
import { ParseError, parseStatement } from "../src/query/index.js";

function parseAll(source: string): unknown[] {
  // Multi-statement helper: each `;`-terminated chunk parsed individually.
  // Splits on top-level `;` (not inside braces/brackets/parens).
  const statements: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of source) {
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === ";" && depth === 0) {
      const s = buf.trim();
      if (s.length > 0) statements.push(s);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim().length > 0) statements.push(buf.trim());
  return statements.map((s) => parseStatement(s));
}

// ──────── Statement verbs at top level ────────

describe("dsl v2: statement verbs", () => {
  it("query { x | expr } — single head var", () => {
    const stmt = parseStatement("query { x | x : Trait }");
    expect(stmt).toMatchObject({
      kind: "query",
      query: {
        head: ["x"],
      },
    });
  });

  it("query { x, y | expr } — multi head vars", () => {
    const stmt = parseStatement("query { x, y | uses(x, y) }");
    if (stmt.kind !== "query") throw new Error("expected query");
    expect(stmt.query.head).toEqual(["x", "y"]);
  });

  it("exists { expr } — yes/no", () => {
    const stmt = parseStatement('exists { exists r : Relation. r.id = "IsPlayer" }');
    expect(stmt).toMatchObject({ kind: "exists" });
  });

  it("∃ { expr } — yes/no unicode", () => {
    const stmt = parseStatement('∃ { ∃ r : Relation. r.id = "IsPlayer" }');
    expect(stmt).toMatchObject({ kind: "exists" });
  });

  it("show <kind> <name>", () => {
    const stmt = parseStatement("show trait Presentable");
    expect(stmt).toEqual({
      kind: "show",
      targetKind: "trait",
      name: "Presentable",
    });
  });

  it("show kind Item", () => {
    const stmt = parseStatement("show kind Item");
    expect(stmt).toEqual({ kind: "show", targetKind: "kind", name: "Item" });
  });

  it("named predicate definition is preserved", () => {
    const stmt = parseStatement("reachable(a, b) :- a -[Path]->+ b");
    expect(stmt.kind).toBe("named_predicate");
  });

  it("bare ?- no longer parses at top level", () => {
    expect(() => parseStatement("?- exists r : Relation. r.id = \"IsPlayer\"")).toThrowError(
      ParseError,
    );
  });

  it("bare comprehension { x | … } no longer parses at top level", () => {
    expect(() => parseStatement("{ k | k : Kind }")).toThrowError(ParseError);
  });
});

// ──────── def trait ────────

describe("dsl v2: def trait", () => {
  it("empty body", () => {
    const stmt = parseStatement("def trait Empty {}");
    expect(stmt).toMatchObject({
      kind: "mutation",
      mutation: { type: "defTrait", spec: { id: "Empty" } },
    });
  });

  it("with field declarations (direct, no fields: wrapper)", () => {
    const stmt = parseStatement(
      'def trait Presentable { name: str = ""; description: str = "" }',
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defTrait") throw new Error("wrong shape");
    expect(stmt.mutation.spec.fields).toEqual([
      { id: "name", type: "str", default: "", hasDefault: true },
      { id: "description", type: "str", default: "", hasDefault: true },
    ]);
  });

  it("field without default", () => {
    const stmt = parseStatement("def trait Combatant { hp: int }");
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defTrait") throw new Error("wrong shape");
    expect(stmt.mutation.spec.fields).toEqual([{ id: "hp", type: "int" }]);
  });

  it("nullable type with `?` suffix", () => {
    const stmt = parseStatement("def trait Relocatable { location: ref<Location>? = null }");
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defTrait") throw new Error("wrong shape");
    expect(stmt.mutation.spec.fields![0]).toEqual({
      id: "location",
      type: "ref<Location>?",
      default: null,
      hasDefault: true,
    });
  });

  it("nested def relation inside trait body", () => {
    const stmt = parseStatement(
      "def trait Location { def relation Path(source: ref<Location>, target: ref<Location>) {} }",
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defTrait") throw new Error("wrong shape");
    expect(stmt.mutation.spec.relations).toBeDefined();
    expect(stmt.mutation.spec.relations![0]?.id).toBe("Path");
  });

  it("nested def action with default effect", () => {
    const stmt = parseStatement(
      "def trait Relocatable { def action Move(actor, subject, destination) { effects: [ assert At(subject, destination) ] } }",
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defTrait") throw new Error("wrong shape");
    expect(stmt.mutation.spec.actions![0]?.id).toBe("Move");
  });
});

// ──────── def relation ────────

describe("dsl v2: def relation", () => {
  it("stored relation (no body)", () => {
    const stmt = parseStatement("def relation Owns(owner, owned) {}");
    expect(stmt).toEqual({
      kind: "mutation",
      mutation: {
        type: "defRelation",
        spec: { id: "Owns", parameters: [{ id: "owner" }, { id: "owned" }] },
      },
    });
  });

  it("derived relation with get clause (semicolon-terminated)", () => {
    const stmt = parseStatement(
      "def relation Reachable(a, b) { get: a -[Path]->+ b }",
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defRelation") throw new Error("wrong shape");
    expect(stmt.mutation.spec.get).toBeDefined();
    expect(stmt.mutation.spec.get!.type).toBe("path");
  });

  it("set clause with semicolon-separated effects", () => {
    const stmt = parseStatement(
      "def relation R(a, b) { set: [ assert Visited(a); retract Stale(a); ] }",
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defRelation") throw new Error("wrong shape");
    expect(stmt.mutation.spec.setEffects).toHaveLength(2);
  });

  it("typed parameters with `?` and `<>` and `=`", () => {
    const stmt = parseStatement(
      "def relation R(a: ref<Actor>?, b: ref<Location> = null) {}",
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defRelation") throw new Error("wrong shape");
    expect(stmt.mutation.spec.parameters[0]?.type).toBe("ref<Actor>?");
    expect(stmt.mutation.spec.parameters[1]?.type).toBe("ref<Location>");
  });

  it("optional return-type annotation parses (documentation-only)", () => {
    const stmt = parseStatement("def relation R(a, b): bool { get: true }");
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defRelation") throw new Error("wrong shape");
    expect(stmt.mutation.spec.id).toBe("R");
    expect(stmt.mutation.spec.get).toBeDefined();
  });
});

// ──────── def action ────────

describe("dsl v2: def action", () => {
  it("with requires and default clauses", () => {
    const stmt = parseStatement(
      "def action Take(actor, item) { requires: CanTouch(actor, item); effects: [ assert CarriedBy(actor, item) ] }",
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defAction") throw new Error("wrong shape");
    expect(stmt.mutation.spec.id).toBe("Take");
    expect(stmt.mutation.spec.requires).toBeDefined();
    expect(stmt.mutation.spec.effects).toHaveLength(1);
  });

  it("optional return-type annotation parses (documentation-only)", () => {
    const stmt = parseStatement("def action A(actor): void { requires: true }");
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defAction") throw new Error("wrong shape");
    expect(stmt.mutation.spec.id).toBe("A");
  });
});

// ──────── def kind ────────

describe("dsl v2: def kind", () => {
  it("colon-separated trait list, no body", () => {
    const stmt = parseStatement("def kind Item: Presentable, Relocatable");
    expect(stmt).toMatchObject({
      kind: "mutation",
      mutation: {
        type: "defKind",
        spec: { id: "Item" },
      },
    });
    if (stmt.kind === "mutation" && stmt.mutation.type === "defKind") {
      expect(stmt.mutation.spec.traits).toEqual(["Presentable", "Relocatable"]);
    }
  });

  it("with empty body", () => {
    const stmt = parseStatement("def kind Item: Presentable, Relocatable {}");
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defKind") throw new Error("wrong shape");
    expect(stmt.mutation.spec.traits).toEqual(["Presentable", "Relocatable"]);
  });

  it("with kind-level field overrides", () => {
    const stmt = parseStatement(
      'def kind Foe: Combatant, Presentable { Presentable.name = "Foe" }',
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defKind") throw new Error("wrong shape");
    expect(stmt.mutation.spec.fields).toEqual({ Presentable: { name: "Foe" } });
  });

  it("kind with no traits is allowed (empty traits)", () => {
    const stmt = parseStatement("def kind Bare {}");
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defKind") throw new Error("wrong shape");
    expect(stmt.mutation.spec.traits).toEqual([]);
  });
});

// ──────── def rulebook / def rule ────────

describe("dsl v2: def rulebook + def rule", () => {
  it("rulebook empty body", () => {
    const stmt = parseStatement("def rulebook EveryTurn {}");
    expect(stmt).toEqual({
      kind: "mutation",
      mutation: { type: "defRulebook", spec: { id: "EveryTurn" } },
    });
  });

  it("rule with phase and match", () => {
    const stmt = parseStatement(
      "def rule Tick in EveryTurn { phase: after; match: Move(actor: a) }",
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defRule") throw new Error("wrong shape");
    expect(stmt.mutation.spec.rulebook).toBe("EveryTurn");
    expect(stmt.mutation.spec.phase).toBe("after");
    expect(stmt.mutation.spec.pattern.action).toBe("Move");
  });

  it("rule with all clauses semicolon-separated", () => {
    const stmt = parseStatement(
      "def rule R in B { phase: after; match: Move(actor: a); guard: exists x. R(x); effects: [ assert Done(a) ]; control: stop; priority: 10 }",
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defRule") throw new Error("wrong shape");
    expect(stmt.mutation.spec.control).toBe("stop");
    expect(stmt.mutation.spec.priority).toBe(10);
  });
});

// ──────── def entity ────────

describe("dsl v2: def entity", () => {
  it("with kind via colon, body has Trait.field overrides with `=`", () => {
    const stmt = parseStatement(
      'def entity grunt: Foe { Combatant.hp = 5; Presentable.name = "Grunt" }',
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defEntity") throw new Error("wrong shape");
    expect(stmt.mutation.spec.id).toBe("grunt");
    expect(stmt.mutation.spec.kind).toBe("Foe");
    expect(stmt.mutation.spec.fields).toEqual({
      Combatant: { hp: 5 },
      Presentable: { name: "Grunt" },
    });
  });

  it("with metadata.<key> = value", () => {
    const stmt = parseStatement(
      'def entity grunt: Foe { metadata.spawned = true }',
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defEntity") throw new Error("wrong shape");
    expect(stmt.mutation.spec.metadata).toEqual({ spawned: true });
  });

  it("with `trait Foo;` grant", () => {
    const stmt = parseStatement(
      'def entity ghost { trait Presentable }',
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defEntity") throw new Error("wrong shape");
    expect(stmt.mutation.spec.traits?.map((t) => t.id)).toEqual(["Presentable"]);
  });

  it("with `trait Foo { f = v };` grant + override", () => {
    const stmt = parseStatement(
      'def entity ghost { trait Presentable { name = "Ghost" } }',
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defEntity") throw new Error("wrong shape");
    const trait = stmt.mutation.spec.traits?.[0];
    expect(trait?.id).toBe("Presentable");
    // Trait grant fields stored as a flat map; in the v2 shape these are
    // unprefixed (no Trait. qualification — the prefix is the trait itself).
    expect(trait?.fields).toEqual({ name: "Ghost" });
  });

  it("auto-resolved field assign without trait prefix", () => {
    const stmt = parseStatement(
      "def entity x: Foe { hp = 5 }",
    );
    if (stmt.kind !== "mutation" || stmt.mutation.type !== "defEntity") throw new Error("wrong shape");
    // Auto-resolution happens at executor time, not parse time. The parser
    // records the unresolved override in a generic bucket — represented as
    // `fields: { "*": { hp: 5 } }` (auto-resolve marker) or by carrying a
    // separate `unresolvedFields` map. Either way: the spec captures the
    // raw assignment. (Exact key TBD by the parser implementation.)
    // For now assert the executor will see *something* — the `fields` key is
    // populated.
    expect(
      stmt.mutation.spec.fields !== undefined ||
        (stmt.mutation.spec as unknown as Record<string, unknown>)["unresolvedFields"] !==
          undefined,
    ).toBe(true);
  });
});

// ──────── undef ────────

describe("dsl v2: undef", () => {
  for (const kind of ["trait", "relation", "action", "kind", "rule", "rulebook", "entity"]) {
    it(`undef ${kind} <name>`, () => {
      const stmt = parseStatement(`undef ${kind} Foo`);
      expect(stmt).toEqual({
        kind: "mutation",
        mutation: { type: "undef", targetKind: kind, name: "Foo" },
      });
    });
  }
});

// ──────── Multi-statement parsing ────────

describe("dsl v2: multi-statement", () => {
  it("two def statements split on `;`", () => {
    const out = parseAll("def trait A {}; def trait B {};");
    expect(out).toHaveLength(2);
    expect((out[0] as { kind: string }).kind).toBe("mutation");
    expect((out[1] as { kind: string }).kind).toBe("mutation");
  });

  it("mixed query + show", () => {
    const out = parseAll("query { k | k : Kind }; show trait Presentable;");
    expect(out).toHaveLength(2);
    expect((out[0] as { kind: string }).kind).toBe("query");
    expect((out[1] as { kind: string }).kind).toBe("show");
  });
});

// ──────── Negatives ────────

describe("dsl v2: negatives", () => {
  it("def trait with no body fails", () => {
    expect(() => parseStatement("def trait T")).toThrowError(ParseError);
  });

  it("def kind with empty `:` (trailing colon, no traits) fails", () => {
    expect(() => parseStatement("def kind X:")).toThrowError(ParseError);
  });

  it("def rule without `in <rulebook>` fails", () => {
    expect(() => parseStatement("def rule R { phase: after; match: M() }")).toThrowError(
      ParseError,
    );
  });

  it("undef with bogus kind fails", () => {
    expect(() => parseStatement("undef widget Foo")).toThrowError(ParseError);
  });

  it("show without target name fails", () => {
    expect(() => parseStatement("show trait")).toThrowError(ParseError);
  });

  it("@module addressing on def heads is rejected", () => {
    expect(() => parseStatement("def trait Foo@game {}")).toThrowError(ParseError);
  });
});

import { describe, expect, it } from "vitest";
import {
  GameDefinition,
  attachment,
  entitySpec,
  field,
  instantiate,
  kind,
  parameter,
  relation,
  trait,
} from "../src/index.js";
import {
  ParseError,
  makeContext,
  parseExpression,
  parseNamedPredicate,
  parseQuery,
  parseStatement,
  runQuery,
  tokenize,
} from "../src/query/index.js";

// ──────── Lexer / tokenizer tests ────────

describe("tokenizer", () => {
  it("recognises ASCII keywords as distinct token types from identifiers", () => {
    const result = tokenize("exists x . R(x) and not foo");
    expect(result.errors).toEqual([]);
    const types = result.tokens.map((t) => t.tokenType.name);
    expect(types).toContain("Exists");
    expect(types).toContain("And");
    expect(types).toContain("Not");
    // Confirm regular identifiers (x, R, x, foo) are Identifier-typed.
    expect(types.filter((n) => n === "Identifier").length).toBe(4);
  });

  it("recognises unicode operators", () => {
    const result = tokenize("∃ x. ¬ R(x) ∧ S(x)");
    expect(result.errors).toEqual([]);
    const types = result.tokens.map((t) => t.tokenType.name);
    expect(types).toContain("ExistsU");
    expect(types).toContain("NotU");
    expect(types).toContain("AndU");
  });

  it("lexes path tokens correctly", () => {
    const result = tokenize("a -[Path]-> b");
    expect(result.errors).toEqual([]);
    const types = result.tokens.map((t) => t.tokenType.name);
    expect(types).toEqual(["Identifier", "PathFwdOpen", "Identifier", "PathClose", "Identifier"]);
  });

  it("lexes regex literals", () => {
    const result = tokenize('t.id =~ /^Can/');
    expect(result.errors).toEqual([]);
    const last = result.tokens[result.tokens.length - 1]!;
    expect(last.tokenType.name).toBe("RegexLiteral");
    expect(last.image).toBe("/^Can/");
  });

  it("lexes string literals", () => {
    const result = tokenize('like(t.id, "%cat%")');
    expect(result.errors).toEqual([]);
    expect(result.tokens.find((t) => t.tokenType.name === "StringLiteral")?.image).toBe(
      '"%cat%"',
    );
  });
});

// ──────── Parser → AST identity tests ────────

describe("parser → AST literal", () => {
  it("?- relation atom", () => {
    expect(parseQuery("?- R(x, y)")).toEqual({
      head: [],
      body: { type: "relation", relation: "R", args: [
        { type: "var", name: "x" },
        { type: "var", name: "y" },
      ] },
    });
  });

  it("comprehension { x | φ }", () => {
    expect(parseQuery("{ x | R(x) }")).toEqual({
      head: ["x"],
      body: { type: "relation", relation: "R", args: [{ type: "var", name: "x" }] },
    });
  });

  it("comprehension with trait filter", () => {
    const q = parseQuery("{ x : Item | R(x) }");
    expect(q.head).toEqual(["x"]);
    expect(q.body).toEqual({
      type: "and",
      left: {
        type: "traitOf",
        entity: { type: "var", name: "x" },
        filter: { name: "Item" },
      },
      right: { type: "relation", relation: "R", args: [{ type: "var", name: "x" }] },
    });
  });

  it("comprehension with scope addressing", () => {
    const q = parseQuery("{ k : Kind@prelude | true }");
    expect(q.body).toEqual({
      type: "and",
      left: {
        type: "traitOf",
        entity: { type: "var", name: "k" },
        filter: { name: "Kind", module: "prelude" },
      },
      right: { type: "literal", value: true },
    });
  });

  it("named predicate definition", () => {
    expect(parseNamedPredicate("reachable(a, b) :- R(a, b)")).toEqual({
      name: "reachable",
      parameters: ["a", "b"],
      body: {
        type: "relation",
        relation: "R",
        args: [
          { type: "var", name: "a" },
          { type: "var", name: "b" },
        ],
      },
    });
  });

  it("conjunction and disjunction (ASCII)", () => {
    expect(parseExpression("R(x) & S(x) | T(x)")).toEqual({
      type: "or",
      left: {
        type: "and",
        left: { type: "relation", relation: "R", args: [{ type: "var", name: "x" }] },
        right: { type: "relation", relation: "S", args: [{ type: "var", name: "x" }] },
      },
      right: { type: "relation", relation: "T", args: [{ type: "var", name: "x" }] },
    });
  });

  it("conjunction and disjunction (word)", () => {
    expect(parseExpression("R(x) and S(x) or T(x)")).toEqual(
      parseExpression("R(x) & S(x) | T(x)"),
    );
  });

  it("conjunction and disjunction (unicode)", () => {
    expect(parseExpression("R(x) ∧ S(x) ∨ T(x)")).toEqual(
      parseExpression("R(x) & S(x) | T(x)"),
    );
  });

  it("not / ¬ are equivalent", () => {
    expect(parseExpression("not R(x)")).toEqual(parseExpression("¬ R(x)"));
    expect(parseExpression("not R(x)")).toEqual({
      type: "not",
      operand: { type: "relation", relation: "R", args: [{ type: "var", name: "x" }] },
    });
  });

  it("exists / ∃ are equivalent", () => {
    expect(parseExpression("exists x. R(x)")).toEqual(parseExpression("∃ x. R(x)"));
  });

  it("forall / ∀ are equivalent and require trait filter at runtime", () => {
    const ast = parseExpression("∀ k : Kind. uses(k, Presentable)");
    expect(ast).toEqual({
      type: "forall",
      variable: "k",
      traitFilter: { name: "Kind" },
      body: {
        type: "relation",
        relation: "uses",
        args: [
          { type: "var", name: "k" },
          { type: "var", name: "Presentable" }, // identifier in arg position is a variable
        ],
      },
    });
  });

  it("equality and inequality (both ASCII and unicode forms)", () => {
    expect(parseExpression("a = b")).toEqual({
      type: "equal",
      left: { type: "var", name: "a" },
      right: { type: "var", name: "b" },
    });
    expect(parseExpression("a != b")).toEqual(parseExpression("a ≠ b"));
    expect(parseExpression("a != b")).toEqual({
      type: "notEqual",
      left: { type: "var", name: "a" },
      right: { type: "var", name: "b" },
    });
  });

  it("regex match", () => {
    expect(parseExpression("t.id =~ /^Can/i")).toEqual({
      type: "regex",
      subject: { type: "field", entity: { type: "var", name: "t" }, field: "id" },
      pattern: "^Can",
      flags: "i",
    });
  });

  it("like call", () => {
    expect(parseExpression('like(t.id, "%cat%")')).toEqual({
      type: "like",
      subject: { type: "field", entity: { type: "var", name: "t" }, field: "id" },
      pattern: "%cat%",
    });
  });

  it("traitOf atom: t : Trait", () => {
    expect(parseExpression("t : Trait")).toEqual({
      type: "traitOf",
      entity: { type: "var", name: "t" },
      filter: { name: "Trait" },
    });
  });

  it("path forward single hop", () => {
    expect(parseExpression("a -[Path]-> b")).toEqual({
      type: "path",
      from: { type: "var", name: "a" },
      to: { type: "var", name: "b" },
      relations: ["Path"],
      direction: "forward",
      quantifier: "1",
    });
  });

  it("path forward transitive", () => {
    const star = parseExpression("a -[Path]->* b");
    if (star.type !== "path") throw new Error("expected path");
    expect(star.quantifier).toBe("*");
    const plus = parseExpression("a -[Path]->+ b");
    if (plus.type !== "path") throw new Error("expected path");
    expect(plus.quantifier).toBe("+");
  });

  it("path backward", () => {
    expect(parseExpression("a <-[Path]- b")).toEqual({
      type: "path",
      from: { type: "var", name: "a" },
      to: { type: "var", name: "b" },
      relations: ["Path"],
      direction: "backward",
      quantifier: "1",
    });
  });

  it("path symmetric (close `]-` after forward open `-[`)", () => {
    const sym = parseExpression("a -[Path]- b");
    if (sym.type !== "path") throw new Error("expected path");
    expect(sym.direction).toBe("symmetric");
  });

  it("path alternation", () => {
    const alt = parseExpression("a -[A|B|C]-> b");
    if (alt.type !== "path") throw new Error("expected path");
    expect(alt.relations).toEqual(["A", "B", "C"]);
  });

  it("string and number literals as terms", () => {
    expect(parseExpression('R("foo", 42, true)')).toEqual({
      type: "relation",
      relation: "R",
      args: [
        { type: "value", value: "foo" },
        { type: "value", value: 42 },
        { type: "value", value: true },
      ],
    });
  });

  it("two-segment field access (entity.Trait.field)", () => {
    expect(parseExpression("e.Presentable.name = x")).toEqual({
      type: "equal",
      left: {
        type: "field",
        entity: { type: "var", name: "e" },
        trait: "Presentable",
        field: "name",
      },
      right: { type: "var", name: "x" },
    });
  });

  it("parens override precedence", () => {
    expect(parseExpression("(R(x) | S(x)) & T(x)")).toEqual({
      type: "and",
      left: {
        type: "or",
        left: { type: "relation", relation: "R", args: [{ type: "var", name: "x" }] },
        right: { type: "relation", relation: "S", args: [{ type: "var", name: "x" }] },
      },
      right: { type: "relation", relation: "T", args: [{ type: "var", name: "x" }] },
    });
  });

  it("comments and whitespace are ignored", () => {
    expect(parseExpression("R(x) # this is a comment\n  & S(x)")).toEqual(
      parseExpression("R(x) & S(x)"),
    );
  });
});

// ──────── Round-trip: parse-then-eval matches eval-on-literal-AST ────────

function buildSmallWorld() {
  const def = new GameDefinition();
  def.addTrait(
    trait("Presentable", "prelude", { fields: [field("name", { type: "str", default: "" })] }),
  );
  def.addTrait(trait("Item", "prelude"));
  def.addTrait(
    trait("Location", "prelude", {
      relations: [
        relation("Path", "prelude", [parameter("source"), parameter("target")]),
      ],
    }),
  );
  def.addTrait(
    trait("Relocatable", "prelude", {
      fields: [field("location", { type: "ref", default: null })],
      relations: [
        relation("At", "prelude", [parameter("subject"), parameter("location")]),
      ],
    }),
  );
  def.addKind(
    kind("Place", "prelude", { traits: [attachment("Presentable"), attachment("Location")] }),
  );
  def.addKind(
    kind("ItemKind", "prelude", {
      traits: [
        attachment("Presentable"),
        attachment("Relocatable"),
        attachment("Item"),
      ],
    }),
  );
  def.addInitialEntity(entitySpec("here", "game", { kind: "Place" }));
  def.addInitialEntity(entitySpec("there", "game", { kind: "Place" }));
  def.addInitialEntity(entitySpec("rock", "game", { kind: "ItemKind" }));
  def.addInitialAssertion({ relation: "Path", args: ["here", "there"], module: "game" });
  def.addInitialAssertion({ relation: "At", args: ["rock", "here"], module: "game" });
  return { def, state: instantiate(def) };
}

describe("round-trip: parse → eval matches expected results", () => {
  it("comprehension over Items", () => {
    const { def, state } = buildSmallWorld();
    const ctx = makeContext(def, { state });
    const result = runQuery(parseQuery("{ x : Item | true }"), ctx);
    expect(new Set(result.rows.map((r) => r["x"]))).toEqual(new Set(["rock"]));
  });

  it("path transitive in DSL matches AST equivalent", () => {
    const { def, state } = buildSmallWorld();
    const ctx = makeContext(def, { state });
    const result = runQuery(parseQuery("{ b | a = \"here\" & a -[Path]->+ b }"), ctx);
    expect(new Set(result.rows.map((r) => r["b"]))).toEqual(new Set(["there"]));
  });

  it("meta-query: Kinds in prelude that use trait Item", () => {
    const { def, state } = buildSmallWorld();
    const ctx = makeContext(def, { state });
    const result = runQuery(
      parseQuery("{ k : Kind@prelude | uses(k, \"Item\") }"),
      ctx,
    );
    expect(new Set(result.rows.map((r) => r["k"]))).toEqual(new Set(["ItemKind"]));
  });

  it("yes/no with regex on Trait.id", () => {
    const { def, state } = buildSmallWorld();
    const ctx = makeContext(def, { state });
    const yes = runQuery(parseQuery("?- exists t : Trait. t.id =~ /^Pre/"), ctx);
    expect(yes.count).toBe(1);
    const no = runQuery(parseQuery("?- exists t : Trait. t.id =~ /^XYZ/"), ctx);
    expect(no.count).toBe(0);
  });

  it("named predicate parses and evaluates in context", () => {
    const { def, state } = buildSmallWorld();
    const reachable = parseNamedPredicate("reachable(a, b) :- a -[Path]->+ b");
    const ctx = makeContext(def, { state, predicates: [reachable] });
    const result = runQuery(
      parseQuery('{ b | reachable("here", b) }'),
      ctx,
    );
    expect(new Set(result.rows.map((r) => r["b"]))).toEqual(new Set(["there"]));
  });

  it("ASCII and unicode forms produce identical results", () => {
    const { def, state } = buildSmallWorld();
    const ctx = makeContext(def, { state });
    const ascii = runQuery(
      parseQuery("?- exists t : Trait. t.id = \"Item\""),
      ctx,
    );
    const uni = runQuery(parseQuery("?- ∃ t : Trait. t.id = \"Item\""), ctx);
    expect(ascii.count).toBe(uni.count);
    expect(ascii.count).toBe(1);
  });
});

// ──────── Error surfaces ────────

describe("parser error surfaces", () => {
  it("unrecognised lexeme throws ParseError with offset", () => {
    expect(() => parseQuery("?- @bad")).toThrowError(ParseError);
  });

  it("unbalanced parens", () => {
    expect(() => parseQuery("?- R(x")).toThrowError(/parse error/);
  });

  it("statement that does not match any top-level shape", () => {
    expect(() => parseStatement("R(x)")).toThrowError(/parse error/);
  });
});


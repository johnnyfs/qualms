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
  relation,
  rule,
  trait,
  pattern,
} from "../src/index.js";
import {
  TRUE,
  and,
  c,
  eq,
  evaluate,
  exists,
  f,
  forall,
  like,
  makeContext,
  namedPredicate,
  neq,
  not,
  or,
  path,
  query,
  regex,
  rel,
  runQuery,
  traitOf,
  v,
  yesNo,
} from "../src/query/index.js";

/**
 * Build a small but expressive world:
 *
 *   prelude:
 *     Trait Presentable { name }
 *     Trait Actor
 *     Trait Location { rel Path(source, target) }
 *     Trait Relocatable { rel At(subject, location) [stored] }
 *     Trait Item        (extension over Presentable+Relocatable)
 *     Relation IsPlayer(actor)             [stored]
 *     Relation CarriedBy(actor, item)      [derived: At(item, actor)]
 *     Action Examine(target)
 *     Kind Thing { Presentable }
 *     Kind Place { Presentable, Location }
 *     Kind Person { Presentable, Actor, Relocatable }
 *     Kind ItemKind { Presentable, Relocatable, Item }
 *
 *   game (story):
 *     entities: here (Place), there (Place), hall (Place), player (Person), rock (ItemKind), gem (ItemKind), keystone (ItemKind)
 *     paths: here→there, there→hall (forward only)
 *     player At here
 *     rock At here
 *     gem  At there
 *     keystone At player  (carried)
 *     IsPlayer(player)
 *
 *   session:
 *     Trait BonusTag (no fields)
 */
function buildWorld(): { def: GameDefinition; state: ReturnType<typeof instantiate> } {
  const def = new GameDefinition();

  // Traits
  def.addTrait(
    trait("Presentable", "prelude", {
      fields: [field("name", { type: "str", default: "" })],
    }),
  );
  def.addTrait(trait("Actor", "prelude"));
  def.addTrait(
    trait("Location", "prelude", {
      relations: [
        relation(
          "Path",
          "prelude",
          [parameter("source"), parameter("target")],
        ),
      ],
    }),
  );
  def.addTrait(
    trait("Relocatable", "prelude", {
      fields: [field("location", { type: "ref", default: null })],
      relations: [
        relation(
          "At",
          "prelude",
          [parameter("subject"), parameter("location")],
        ),
      ],
    }),
  );
  def.addTrait(trait("Item", "prelude"));

  // Top-level relations
  def.addRelation(
    relation("IsPlayer", "prelude", [parameter("actor")]),
  );
  // Derived: CarriedBy(actor, item) :- At(item, actor)
  def.addRelation(
    relation("CarriedBy", "prelude", [parameter("actor"), parameter("item")], {
      get: rel("At", [v("item"), v("actor")]),
    }),
  );

  // Actions (referenced in tests)
  def.addAction(action("Examine", "prelude", [parameter("target")]));

  // Kinds
  def.addKind(kind("Thing", "prelude", { traits: [attachment("Presentable")] }));
  def.addKind(
    kind("Place", "prelude", {
      traits: [attachment("Presentable"), attachment("Location")],
    }),
  );
  def.addKind(
    kind("Person", "prelude", {
      traits: [
        attachment("Presentable"),
        attachment("Actor"),
        attachment("Relocatable"),
      ],
    }),
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

  // Game-layer story content
  def.addInitialEntity(
    entitySpec("here", "game", {
      kind: "Place",
      fields: { Presentable: { name: "Here" } },
    }),
  );
  def.addInitialEntity(
    entitySpec("there", "game", {
      kind: "Place",
      fields: { Presentable: { name: "There" } },
    }),
  );
  def.addInitialEntity(
    entitySpec("hall", "game", {
      kind: "Place",
      fields: { Presentable: { name: "Hall" } },
    }),
  );
  def.addInitialEntity(
    entitySpec("player", "game", {
      kind: "Person",
      fields: { Presentable: { name: "Player" } },
    }),
  );
  def.addInitialEntity(
    entitySpec("rock", "game", {
      kind: "ItemKind",
      fields: { Presentable: { name: "rock" } },
    }),
  );
  def.addInitialEntity(
    entitySpec("gem", "game", {
      kind: "ItemKind",
      fields: { Presentable: { name: "gem" } },
    }),
  );
  def.addInitialEntity(
    entitySpec("keystone", "game", {
      kind: "ItemKind",
      fields: { Presentable: { name: "keystone" } },
    }),
  );

  def.addInitialAssertion({ relation: "Path", args: ["here", "there"], module: "game" });
  def.addInitialAssertion({ relation: "Path", args: ["there", "hall"], module: "game" });
  def.addInitialAssertion({ relation: "At", args: ["player", "here"], module: "game" });
  def.addInitialAssertion({ relation: "At", args: ["rock", "here"], module: "game" });
  def.addInitialAssertion({ relation: "At", args: ["gem", "there"], module: "game" });
  def.addInitialAssertion({ relation: "At", args: ["keystone", "player"], module: "game" });
  def.addInitialAssertion({ relation: "IsPlayer", args: ["player"], module: "game" });

  // Session-layer overlay
  def.addTrait(trait("BonusTag", "session"));

  const state = instantiate(def);
  return { def, state };
}

describe("evaluator: ground stored relations", () => {
  it("scans tuples and binds free variables", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const result = runQuery(query(["x", "y"], rel("At", [v("x"), v("y")])), ctx);
    const pairs = new Set(result.rows.map((r) => `${r["x"]}->${r["y"]}`));
    expect(pairs.has("player->here")).toBe(true);
    expect(pairs.has("rock->here")).toBe(true);
    expect(pairs.has("gem->there")).toBe(true);
    expect(pairs.has("keystone->player")).toBe(true);
    expect(pairs.size).toBe(4);
  });

  it("filters by partially-bound args", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const result = runQuery(query(["x"], rel("At", [v("x"), c("here")])), ctx);
    const xs = new Set(result.rows.map((r) => r["x"]));
    expect(xs).toEqual(new Set(["player", "rock"]));
  });

  it("yes/no ?- form returns one row on success, zero on failure", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    expect(runQuery(yesNo(rel("IsPlayer", [c("player")])), ctx).count).toBe(1);
    expect(runQuery(yesNo(rel("IsPlayer", [c("rock")])), ctx).count).toBe(0);
  });
});

describe("evaluator: derived relations with inlining", () => {
  it("CarriedBy(player, ?item) returns At-into-player", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const result = runQuery(
      query(["item"], rel("CarriedBy", [c("player"), v("item")])),
      ctx,
    );
    const items = new Set(result.rows.map((r) => r["item"]));
    expect(items).toEqual(new Set(["keystone"]));
  });

  it("derived relation works with both args unbound (constrained to Actor for clarity)", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    // CarriedBy is a syntactic inverse of At, so it derives any (a, i) where At(i, a)
    // — including (here, rock) etc. Filter to Actors to get the "real" carrying tuples.
    const result = runQuery(
      query(
        ["actor", "item"],
        and(
          traitOf(v("actor"), "Actor"),
          rel("CarriedBy", [v("actor"), v("item")]),
        ),
      ),
      ctx,
    );
    const pairs = result.rows.map((r) => `${r["actor"]}->${r["item"]}`);
    expect(pairs).toEqual(["player->keystone"]);
  });

  it("unconstrained derived relation reflects the syntactic inverse", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    // Without an Actor constraint, CarriedBy(a, i) :- At(i, a) returns every (loc, item) pair too.
    const result = runQuery(
      query(["actor", "item"], rel("CarriedBy", [v("actor"), v("item")])),
      ctx,
    );
    const pairs = new Set(result.rows.map((r) => `${r["actor"]}->${r["item"]}`));
    expect(pairs).toEqual(
      new Set(["here->player", "here->rock", "there->gem", "player->keystone"]),
    );
  });
});

describe("evaluator: traitOf and exists/forall", () => {
  it("enumerates entities by trait", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const result = runQuery(query(["x"], traitOf(v("x"), "Item")), ctx);
    const xs = new Set(result.rows.map((r) => r["x"]));
    expect(xs).toEqual(new Set(["rock", "gem", "keystone"]));
  });

  it("exists with traitFilter projects existential variable away", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    // Find places that contain at least one item (via At).
    const q = query(
      ["place"],
      and(
        traitOf(v("place"), "Location"),
        exists("i", rel("At", [v("i"), v("place")]), { name: "Item" }),
      ),
    );
    const places = new Set(runQuery(q, ctx).rows.map((r) => r["place"]));
    expect(places).toEqual(new Set(["here", "there"]));
  });

  it("forall asserts a property holds for every member of the universe", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    // Every Item has a Presentable trait? Yes.
    const yes = runQuery(
      yesNo(forall("x", traitOf(v("x"), "Presentable"), { name: "Item" })),
      ctx,
    );
    expect(yes.count).toBe(1);
    // Every Item is an Actor? No.
    const no = runQuery(
      yesNo(forall("x", traitOf(v("x"), "Actor"), { name: "Item" })),
      ctx,
    );
    expect(no.count).toBe(0);
  });
});

describe("evaluator: path patterns", () => {
  it("single-hop forward matches direct edges", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const result = runQuery(
      query(["b"], path(c("here"), "Path", v("b"), { quantifier: "1" })),
      ctx,
    );
    expect(result.rows.map((r) => r["b"])).toEqual(["there"]);
  });

  it("transitive (* one or more) yields reachable nodes including indirect", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const result = runQuery(
      query(["b"], path(c("here"), "Path", v("b"), { quantifier: "+" })),
      ctx,
    );
    expect(new Set(result.rows.map((r) => r["b"]))).toEqual(new Set(["there", "hall"]));
  });

  it("zero-or-more includes the source itself", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const result = runQuery(
      query(["b"], path(c("here"), "Path", v("b"), { quantifier: "*" })),
      ctx,
    );
    expect(new Set(result.rows.map((r) => r["b"]))).toEqual(
      new Set(["here", "there", "hall"]),
    );
  });

  it("backward direction reverses the edge (from hall, reverse-walk to sources)", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    // path(hall, Path, ?b, backward, +) = "from hall, walk reversed Path edges to reach b".
    // With Path(here, there), Path(there, hall), reversed gives there→here, hall→there.
    // From hall we reach there, then here.
    const result = runQuery(
      query(["b"], path(c("hall"), "Path", v("b"), { direction: "backward", quantifier: "+" })),
      ctx,
    );
    expect(new Set(result.rows.map((r) => r["b"]))).toEqual(new Set(["there", "here"]));
  });
});

describe("evaluator: equality, regex, like, negation", () => {
  it("equal binds an unbound term", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const result = runQuery(query(["x"], eq(v("x"), c("hello"))), ctx);
    expect(result.rows).toEqual([{ x: "hello" }]);
  });

  it("notEqual filters", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const q = query(
      ["x"],
      and(traitOf(v("x"), "Item"), neq(v("x"), c("rock"))),
    );
    const xs = new Set(runQuery(q, ctx).rows.map((r) => r["x"]));
    expect(xs).toEqual(new Set(["gem", "keystone"]));
  });

  it("regex matches on a string-valued field", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    // Find Traits whose id starts with 'P'.
    const q = query(
      ["t"],
      and(traitOf(v("t"), "Trait"), regex(f(v("t"), "id"), "^P", "")),
    );
    const ts = new Set(runQuery(q, ctx).rows.map((r) => r["t"]));
    expect(ts).toEqual(new Set(["Presentable"]));
  });

  it("like matches with SQL-style wildcards", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    // Find Traits whose id contains 'xyz' (none should match — chosen to be absent).
    const noMatch = runQuery(
      query(["t"], and(traitOf(v("t"), "Trait"), like(f(v("t"), "id"), "%xyz%"))),
      ctx,
    );
    expect(noMatch.count).toBe(0);
    // ...whose id starts with 'It'.
    const itStart = runQuery(
      query(["t"], and(traitOf(v("t"), "Trait"), like(f(v("t"), "id"), "It%"))),
      ctx,
    );
    expect(new Set(itStart.rows.map((r) => r["t"]))).toEqual(new Set(["Item"]));
    // ...containing 'cat' — matches Location and Relocatable.
    const containsCat = runQuery(
      query(["t"], and(traitOf(v("t"), "Trait"), like(f(v("t"), "id"), "%cat%"))),
      ctx,
    );
    expect(new Set(containsCat.rows.map((r) => r["t"]))).toEqual(
      new Set(["Location", "Relocatable"]),
    );
  });

  it("not is negation-as-failure", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const q = query(
      ["x"],
      and(traitOf(v("x"), "Item"), not(rel("At", [v("x"), c("here")]))),
    );
    expect(new Set(runQuery(q, ctx).rows.map((r) => r["x"]))).toEqual(
      new Set(["gem", "keystone"]),
    );
  });
});

describe("evaluator: meta queries (introspection relations)", () => {
  it("uses(kind, trait) enumerates kind→trait attachments", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const q = query(["k"], rel("uses", [v("k"), c("Item")]));
    const ks = new Set(runQuery(q, ctx).rows.map((r) => r["k"]));
    expect(ks).toEqual(new Set(["ItemKind"]));
  });

  it("instance_of(entity, kind) enumerates entity kinds", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const q = query(["e"], rel("instance_of", [v("e"), c("Place")]));
    const es = new Set(runQuery(q, ctx).rows.map((r) => r["e"]));
    expect(es).toEqual(new Set(["here", "there", "hall"]));
  });

  it("defines(trait, name) lifts trait-owned relations and fields", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const q = query(["n"], rel("defines", [c("Relocatable"), v("n")]));
    const ns = new Set(runQuery(q, ctx).rows.map((r) => r["n"]));
    // Relocatable defines field 'location' and relation 'At'.
    expect(ns).toEqual(new Set(["location", "At"]));
  });

  it("composes meta and world: entities of kinds that use trait Item", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const q = query(
      ["e"],
      exists(
        "k",
        and(rel("instance_of", [v("e"), v("k")]), rel("uses", [v("k"), c("Item")])),
      ),
    );
    const es = new Set(runQuery(q, ctx).rows.map((r) => r["e"]));
    expect(es).toEqual(new Set(["rock", "gem", "keystone"]));
  });
});

describe("evaluator: meta-types and scope addressing", () => {
  it("traitOf on Trait enumerates all traits across layers", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const q = query(["t"], traitOf(v("t"), "Trait"));
    const ts = new Set(runQuery(q, ctx).rows.map((r) => r["t"]));
    expect(ts.has("Presentable")).toBe(true);
    expect(ts.has("Item")).toBe(true);
    expect(ts.has("BonusTag")).toBe(true); // session-layer trait still in merged view
  });

  it("Trait@prelude restricts to prelude layer", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const q = query(["t"], traitOf(v("t"), { name: "Trait", module: "prelude" }));
    const ts = new Set(runQuery(q, ctx).rows.map((r) => r["t"]));
    expect(ts.has("Presentable")).toBe(true);
    expect(ts.has("BonusTag")).toBe(false);
  });

  it("Trait@session restricts to session layer", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const q = query(["t"], traitOf(v("t"), { name: "Trait", module: "session" }));
    const ts = new Set(runQuery(q, ctx).rows.map((r) => r["t"]));
    expect(ts).toEqual(new Set(["BonusTag"]));
  });

  it("layer filter on a non-meta trait throws", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    expect(() =>
      runQuery(query(["x"], traitOf(v("x"), { name: "Item", module: "prelude" })), ctx),
    ).toThrowError(/layer filter/);
  });

  it("regex over Relation@prelude with ^Can prefix", () => {
    const { def, state } = buildWorld();
    // Add a Can-prefixed derived relation just for this test.
    def.addRelation(
      relation("CanFoo", "prelude", [parameter("a")], { get: TRUE }),
    );
    const ctx = makeContext(def, { state });
    const q = query(
      ["r"],
      and(
        traitOf(v("r"), { name: "Relation", module: "prelude" }),
        regex(f(v("r"), "id"), "^Can"),
      ),
    );
    const rs = new Set(runQuery(q, ctx).rows.map((r) => r["r"]));
    expect(rs).toEqual(new Set(["CanFoo"]));
  });
});

describe("evaluator: named user predicates", () => {
  it("inlines a recursive named predicate via base/rec rules — implemented as paths here", () => {
    const { def, state } = buildWorld();
    // Define reachable(a, b) :- a -[Path]->* b
    // Step 2 supports named predicates with non-recursive bodies; we can use path
    // for transitivity.
    const reachable = namedPredicate(
      "reachable",
      ["a", "b"],
      path(v("a"), "Path", v("b"), { quantifier: "+" }),
    );
    const ctx = makeContext(def, { state, predicates: [reachable] });
    const q = query(
      ["dest"],
      rel("reachable", [c("here"), v("dest")]),
    );
    const dests = new Set(runQuery(q, ctx).rows.map((r) => r["dest"]));
    expect(dests).toEqual(new Set(["there", "hall"]));
  });

  it("composes named predicates with introspection: items in places reachable from here", () => {
    const { def, state } = buildWorld();
    const reachable = namedPredicate(
      "reachable",
      ["a", "b"],
      path(v("a"), "Path", v("b"), { quantifier: "*" }),
    );
    const ctx = makeContext(def, { state, predicates: [reachable] });
    const q = query(
      ["i"],
      and(
        traitOf(v("i"), "Item"),
        exists(
          "p",
          and(
            rel("reachable", [c("here"), v("p")]),
            rel("At", [v("i"), v("p")]),
          ),
          { name: "Location" },
        ),
      ),
    );
    const items = new Set(runQuery(q, ctx).rows.map((r) => r["i"]));
    // rock @ here (here ⟶* here), gem @ there (here ⟶* there). keystone @ player → not in places.
    expect(items).toEqual(new Set(["rock", "gem"]));
  });
});

describe("evaluator: or, conjunction with 0 / 1 parts", () => {
  it("or yields the union and dedupes", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const q = query(
      ["x"],
      or(rel("At", [v("x"), c("here")]), rel("At", [v("x"), c("there")])),
    );
    const xs = new Set(runQuery(q, ctx).rows.map((r) => r["x"]));
    expect(xs).toEqual(new Set(["player", "rock", "gem"]));
  });

  it("and with literal true is identity", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    const q = query(["x"], and(traitOf(v("x"), "Item"), TRUE));
    const xs = new Set(runQuery(q, ctx).rows.map((r) => r["x"]));
    expect(xs).toEqual(new Set(["rock", "gem", "keystone"]));
  });
});

describe("evaluator: error surfaces", () => {
  it("unknown relation throws", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    expect(() => runQuery(yesNo(rel("Ghost", [c("x")])), ctx)).toThrowError(/unknown relation 'Ghost'/);
  });

  it("regex on unbound subject throws", () => {
    const { def, state } = buildWorld();
    const ctx = makeContext(def, { state });
    expect(() => runQuery(yesNo(regex(v("x"), ".*")), ctx)).toThrowError(/unbound/);
  });
});

describe("evaluator: rule-defined entities are still present in meta scans", () => {
  it("a rule's id is enumerable as a Rule meta-entity", () => {
    const def = new GameDefinition();
    def.addAction(action("X", "prelude", []));
    def.addRule(
      rule("noop", "prelude", "after", { pattern: pattern("X") }),
    );
    const ctx = makeContext(def);
    const q = query(["r"], traitOf(v("r"), "Rule"));
    const rs = new Set(runQuery(q, ctx).rows.map((r) => r["r"]));
    expect(rs).toEqual(new Set(["noop"]));
  });
});

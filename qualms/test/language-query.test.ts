import { describe, expect, it } from "vitest";
import {
  LanguageModelError,
  loadStoryProgram,
  parseProgram,
  playLanguageQuery,
} from "../src/language/index.js";

describe("query — parsing", () => {
  it("parses a query statement", () => {
    const program = parseProgram(`
      trait Actor
      trait Portable
      relation Carrying(Actor, Portable)
      query Inventory(actor: Actor) {
        Carrying(actor, ?item)
      }
    `);
    const query = program.statements.find((s) => s.kind === "query");
    expect(query).toBeDefined();
    if (query?.kind === "query") {
      expect(query.id).toBe("Inventory");
      expect(query.parameters).toHaveLength(1);
      expect(query.body.kind).toBe("relation");
    }
  });

  it("rejects duplicate callable names across kinds", () => {
    expect(() =>
      loadStoryProgram(`
        trait Actor
        trait Portable
        relation Carrying(Actor, Portable)
        predicate Inventory(actor: Actor) { when (Carrying(actor, ?item)) { succeed; } }
        query Inventory(actor: Actor) { Carrying(actor, ?item) }
      `),
    ).toThrow(LanguageModelError);
  });
});

describe("playLanguageQuery — evaluation", () => {
  const SOURCE = `
    trait Actor
    trait Portable
    trait Locatable
    trait Location
    relation At(subject: Locatable, location: Location) unique(subject)
    relation Carrying(Actor, Portable)
    query Inventory(actor: Actor) {
      Carrying(actor, ?item)
    }
    query VisibleAt(actor: Actor) {
      At(actor, ?here) & At(?item, ?here)
    }
    entity Player { Actor, Locatable }
    entity Cell { Location }
    entity BoneShard { Portable, Locatable }
    entity MasterKey { Portable, Locatable }
    set {
      At(Player, Cell);
      Carrying(Player, BoneShard);
      Carrying(Player, MasterKey);
    }
  `;

  it("returns all matching bindings for a single-variable query", () => {
    const model = loadStoryProgram(SOURCE);
    const result = playLanguageQuery(model, "Inventory(Player)");
    expect(result.status).toBe("passed");
    expect(result.outputs).toEqual(["item"]);
    expect(result.bindings).toHaveLength(2);
    const items = result.bindings.map((b) => (b.item?.kind === "id" ? b.item.id : ""));
    expect(items.sort()).toEqual(["BoneShard", "MasterKey"]);
  });

  it("returns an empty binding list (status passed) when nothing matches", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Portable
      relation Carrying(Actor, Portable)
      query Inventory(actor: Actor) { Carrying(actor, ?item) }
      entity Player { Actor }
    `);
    const result = playLanguageQuery(model, "Inventory(Player)");
    expect(result.status).toBe("passed");
    expect(result.bindings).toEqual([]);
    expect(result.outputs).toEqual(["item"]);
  });

  it("returns failed status for an unknown query", () => {
    const model = loadStoryProgram(`trait Actor entity Player { Actor }`);
    const result = playLanguageQuery(model, "Inventory(Player)");
    expect(result.status).toBe("failed");
    expect(result.failures[0]?.kind).toBe("unknown_action");
  });

  it("returns failed status when the actor's parameter type doesn't match", () => {
    const model = loadStoryProgram(SOURCE);
    const result = playLanguageQuery(model, "Inventory(BoneShard)");
    expect(result.status).toBe("failed");
  });

  it("supports multi-variable queries (multiple outputs per binding)", () => {
    const model = loadStoryProgram(SOURCE);
    const result = playLanguageQuery(model, "VisibleAt(Player)");
    expect(result.status).toBe("passed");
    expect(result.outputs).toContain("here");
    expect(result.outputs).toContain("item");
    // Player is at Cell; only the player has an At fact at Cell — bindings include {here: Cell, item: Player}
    const hereItems = result.bindings.map((b) => ({
      here: b.here?.kind === "id" ? b.here.id : "",
      item: b.item?.kind === "id" ? b.item.id : "",
    }));
    expect(hereItems).toContainEqual({ here: "Cell", item: "Player" });
  });
});

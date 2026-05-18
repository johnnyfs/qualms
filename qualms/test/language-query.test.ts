import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LanguageModelError,
  loadStoryProgram,
  parseProgram,
  playLanguageCall,
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

describe("tutorial engine queries", () => {
  const TUTORIAL = readFileSync(
    join(import.meta.dirname, "../../stories/tutorial/tutorial.qualms"),
    "utf-8",
  );

  function idsOf(bindings: ReadonlyArray<Record<string, unknown>>, key: string): string[] {
    return bindings
      .map((b) => {
        const v = b[key] as { kind?: string; id?: string } | undefined;
        return v?.kind === "id" && typeof v.id === "string" ? v.id : "";
      })
      .filter((id) => id.length > 0)
      .sort();
  }

  describe("Visible", () => {
    it("includes co-located items and cross-room targets through transparent bars", () => {
      const model = loadStoryProgram(TUTORIAL);
      const result = playLanguageQuery(model, "Visible(Player)");
      expect(result.status).toBe("passed");
      const ids = idsOf(result.bindings, "target");
      // Co-located (Cell): Bars, BoneShard
      expect(ids).toContain("Bars");
      expect(ids).toContain("BoneShard");
      // Cross-room via transparent bars + ConveysVisibility: Guard in Corridor
      expect(ids).toContain("Guard");
      // The Mop is behind an opaque closed door (ClosetDoor) — not visible
      expect(ids).not.toContain("Mop");
    });
  });

  describe("Topics", () => {
    it("is empty before a conversation has been opened", () => {
      const model = loadStoryProgram(TUTORIAL);
      const result = playLanguageQuery(model, "Topics(Player, Guard)");
      expect(result.status).toBe("passed");
      expect(result.bindings).toEqual([]);
    });

    it("returns sub-topics of the current topic after TalkTo opens the conversation", () => {
      const model = loadStoryProgram(TUTORIAL);
      expect(playLanguageCall(model, "TalkTo(Player, Guard)").status).toBe("passed");
      const result = playLanguageQuery(model, "Topics(Player, Guard)");
      const topics = idsOf(result.bindings, "topic");
      // LeadsTo(Guard, Whatever, …) covers Bribery and Weather.
      expect(topics).toContain("Bribery");
      expect(topics).toContain("Weather");
      // Whatever is the root, not a child of itself.
      expect(topics).not.toContain("Whatever");
    });
  });

  describe("CurrentTopic", () => {
    it("is empty before a conversation and reflects InConversation after TalkTo", () => {
      const model = loadStoryProgram(TUTORIAL);
      expect(playLanguageQuery(model, "CurrentTopic(Player, Guard)").bindings).toEqual([]);
      playLanguageCall(model, "TalkTo(Player, Guard)");
      const after = playLanguageQuery(model, "CurrentTopic(Player, Guard)");
      const topics = idsOf(after.bindings, "topic");
      expect(topics).toEqual(["Whatever"]);
    });
  });
});

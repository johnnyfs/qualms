import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { language } from "@quealm/qualms";
import { currentLocation, visibleEntities } from "../../src/play/resolve.js";
import { defaultPlayConfig, parsePlayConfig } from "../../src/play/config.js";

const { loadStoryProgram } = language;

const TUTORIAL = readFileSync(
  join(import.meta.dirname, "../../../stories/tutorial/tutorial.qualms"),
  "utf-8",
);

describe("currentLocation", () => {
  it("finds the player's location via At facts", () => {
    const model = loadStoryProgram(TUTORIAL);
    expect(currentLocation(model, defaultPlayConfig())).toBe("ActOne.Cell");
  });

  it("returns undefined when the player has no location fact", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Locatable
      trait Location
      relation At(subject: Locatable, location: Location) unique(subject)
      entity Player { Actor, Locatable }
      entity Cell { Location }
    `);
    expect(currentLocation(model, defaultPlayConfig())).toBeUndefined();
  });

  it("respects configured locationFact relation", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Locatable
      trait Location
      relation HasPosition(subject: Locatable, location: Location) unique(subject)
      relation At(Locatable, Location)
      entity Player { Actor, Locatable }
      entity Cell { Location }
      set { HasPosition(Player, Cell); }
    `);
    const config = parsePlayConfig(`visibility:\n  locationFact: HasPosition\n`);
    expect(currentLocation(model, config)).toBe("Cell");
  });
});

describe("visibleEntities", () => {
  it("uses the IsVisibleTo predicate when available (cross-room visibility through transparent bars)", () => {
    const model = loadStoryProgram(TUTORIAL);
    // After tutorial loads, player is in Cell. Bars are transparent and Path(Cell, Corridor) conveys visibility,
    // so Guard (in Corridor) should be visible from the Cell.
    const { ids, usedFallback } = visibleEntities(model, defaultPlayConfig());
    expect(usedFallback).toBe(false);
    expect(ids).toContain("ActOne.Bars");
    expect(ids).toContain("Guard");
    // Mop is in the Closet, but the ClosetDoor is opaque and closed.
    expect(ids).not.toContain("Mop");
    // The player is excluded
    expect(ids).not.toContain("Player");
  });

  it("falls back to At-colocation when the predicate is missing", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Locatable
      trait Location
      relation At(subject: Locatable, location: Location) unique(subject)
      entity Player { Actor, Locatable }
      entity Cell { Location }
      entity BoneShard { Locatable }
      entity Mop { Locatable }
      entity OtherRoom { Location }
      set {
        At(Player, Cell);
        At(BoneShard, Cell);
        At(Mop, OtherRoom);
      }
    `);
    const { ids, usedFallback } = visibleEntities(model, defaultPlayConfig());
    expect(usedFallback).toBe(true);
    expect(ids).toEqual(["BoneShard"]);
  });
});

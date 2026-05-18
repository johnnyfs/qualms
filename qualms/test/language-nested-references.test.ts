import { describe, expect, it } from "vitest";
import {
  evalLanguageAtom,
  factFromAtom,
  idTerm,
  loadStoryProgram,
  parseRelationAtom,
  playLanguageQuery,
  relationTerm,
} from "../src/language/index.js";

const SOURCE = `
  trait Door
  trait Location
  relation Path(from: Location, to: Location)
  relation Gated(path: Path, door: Door) unique(path)
  entity Corridor { Location }
  entity Closet { Location }
  entity ClosetDoor { Door }
  set {
    Gated(Path(Corridor, Closet), ClosetDoor);
  }
`;

describe("nested relation references — by-reference semantics", () => {
  it("keeps the Gated fact in storage when the inner Path is absent", () => {
    const model = loadStoryProgram(SOURCE);
    expect(
      model.hasFact("Gated", [
        relationTerm("Path", [idTerm("Corridor"), idTerm("Closet")]),
        idTerm("ClosetDoor"),
      ]),
    ).toBe(true);
  });

  it("does not match Gated when the inner Path fact is missing", () => {
    const model = loadStoryProgram(SOURCE);
    const result = evalLanguageAtom(model, "Gated(Path(Corridor, Closet), ?door)");
    expect(result.status).toBe("failed");
  });

  it("matches Gated once the inner Path fact is asserted", () => {
    const model = loadStoryProgram(SOURCE);
    model.assertFact(factFromAtom(parseRelationAtom("Path(Corridor, Closet)")));
    const result = evalLanguageAtom(model, "Gated(Path(Corridor, Closet), ?door)");
    expect(result.status).toBe("passed");
  });

  it("becomes unreachable again when the Path is retracted", () => {
    const model = loadStoryProgram(SOURCE);
    const pathFact = factFromAtom(parseRelationAtom("Path(Corridor, Closet)"));
    model.assertFact(pathFact);
    expect(evalLanguageAtom(model, "Gated(Path(Corridor, Closet), ?door)").status).toBe("passed");

    model.retractFact(pathFact);
    expect(evalLanguageAtom(model, "Gated(Path(Corridor, Closet), ?door)").status).toBe("failed");
    // Storage is preserved.
    expect(
      model.hasFact("Gated", [
        relationTerm("Path", [idTerm("Corridor"), idTerm("Closet")]),
        idTerm("ClosetDoor"),
      ]),
    ).toBe(true);

    // Restoring the Path makes Gated reachable again — no instance identity.
    model.assertFact(pathFact);
    expect(evalLanguageAtom(model, "Gated(Path(Corridor, Closet), ?door)").status).toBe("passed");
  });

  it("excludes Gated facts with missing Paths from variable-bound queries", () => {
    const model = loadStoryProgram(`
      trait Door
      trait Location
      relation Path(from: Location, to: Location)
      relation Gated(path: Path, door: Door) unique(path)
      query AllGated() {
        Gated(?path, ?door)
      }
      entity Corridor { Location }
      entity Closet { Location }
      entity Cell { Location }
      entity ClosetDoor { Door }
      entity Bars { Door }
      set {
        Path(Cell, Corridor);
        Gated(Path(Cell, Corridor), Bars);
        Gated(Path(Corridor, Closet), ClosetDoor);
      }
    `);

    const result = playLanguageQuery(model, "AllGated()");
    expect(result.status).toBe("passed");
    // Only the gate whose Path is also present should appear.
    expect(result.bindings).toHaveLength(1);
    const [only] = result.bindings;
    expect(only?.door?.kind === "id" && only.door.id).toBe("Bars");
  });

  it("makes negation succeed when either the wrapper or the inner relation is absent", () => {
    const model = loadStoryProgram(`
      trait Door
      trait Location
      relation Path(from: Location, to: Location)
      relation Gated(path: Path, door: Door) unique(path)
      query Ungated() {
        !Gated(Path(Corridor, Closet), ClosetDoor)
      }
      entity Corridor { Location }
      entity Closet { Location }
      entity ClosetDoor { Door }
      set {
        Gated(Path(Corridor, Closet), ClosetDoor);
      }
    `);

    // Gated stored, Path missing → !Gated(...) succeeds.
    expect(playLanguageQuery(model, "Ungated()").bindings).toHaveLength(1);

    model.assertFact(factFromAtom(parseRelationAtom("Path(Corridor, Closet)")));
    // Both present → !Gated(...) has no bindings.
    expect(playLanguageQuery(model, "Ungated()").bindings).toHaveLength(0);

    // Retract Gated, keep Path → !Gated(...) succeeds again.
    model.retractFact(
      factFromAtom(parseRelationAtom("Gated(Path(Corridor, Closet), ClosetDoor)")),
    );
    expect(playLanguageQuery(model, "Ungated()").bindings).toHaveLength(1);
  });

  it("fails relation-typed parameter binding when the referenced fact is missing", () => {
    const model = loadStoryProgram(`
      trait Door
      trait Location
      relation Path(from: Location, to: Location)
      relation Gated(path: Path, door: Door) unique(path)
      predicate IsGated(p: Path) {
        when (Gated(p, ?door)) { succeed; }
      }
      entity Corridor { Location }
      entity Closet { Location }
      entity ClosetDoor { Door }
      set {
        Gated(Path(Corridor, Closet), ClosetDoor);
      }
    `);

    // Path arg is structurally fine and matches a stored Gated, but the Path
    // fact itself does not exist — parameter binding rejects the call.
    expect(evalLanguageAtom(model, "IsGated(Path(Corridor, Closet))").status).toBe("failed");

    model.assertFact(factFromAtom(parseRelationAtom("Path(Corridor, Closet)")));
    expect(evalLanguageAtom(model, "IsGated(Path(Corridor, Closet))").status).toBe("passed");
  });

  it("requires every layer to exist for a deeply-nested reference", () => {
    const model = loadStoryProgram(`
      trait Thing
      relation Inner(t: Thing)
      relation Mid(i: Inner)
      relation Outer(m: Mid)
      entity X { Thing }
      set {
        Outer(Mid(Inner(X)));
      }
    `);

    // No Mid fact, no Inner fact → unreachable.
    expect(evalLanguageAtom(model, "Outer(Mid(Inner(X)))").status).toBe("failed");

    model.assertFact(factFromAtom(parseRelationAtom("Inner(X)")));
    // Inner exists but Mid does not.
    expect(evalLanguageAtom(model, "Outer(Mid(Inner(X)))").status).toBe("failed");

    model.assertFact(factFromAtom(parseRelationAtom("Mid(Inner(X))")));
    // All three layers present → reachable.
    expect(evalLanguageAtom(model, "Outer(Mid(Inner(X)))").status).toBe("passed");

    // Retract the innermost — propagates failure up.
    model.retractFact(factFromAtom(parseRelationAtom("Inner(X)")));
    expect(evalLanguageAtom(model, "Outer(Mid(Inner(X)))").status).toBe("failed");
  });
});

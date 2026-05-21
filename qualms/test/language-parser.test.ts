import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const TUTORIAL_PATH = resolve(__filename, "../../../stories/tutorial/tutorial.qualms");

const { parseProgram } = language;

describe("tutorial language parser", () => {
  it("parses the tutorial fixture into the new top-level statement shapes", () => {
    const source = readFileSync(TUTORIAL_PATH, "utf-8");
    const program = parseProgram(source);

    expect(program.statements.filter((s) => s.kind === "trait")).toHaveLength(10);
    expect(program.statements.filter((s) => s.kind === "relation")).toHaveLength(13);
    expect(program.statements.filter((s) => s.kind === "predicate")).toHaveLength(5);
    expect(program.statements.filter((s) => s.kind === "action")).toHaveLength(15);
    expect(program.statements.filter((s) => s.kind === "case")).toHaveLength(0);
    expect(program.statements.filter((s) => s.kind === "mockupStart")).toHaveLength(1);
    expect(program.statements.filter((s) => s.kind === "mockup")).toHaveLength(14);
    expect(program.statements.filter((s) => s.kind === "rule")).toHaveLength(9);
    expect(program.statements.filter((s) => s.kind === "namespace")).toHaveLength(4);
    expect(program.statements.filter((s) => s.kind === "entity")).toHaveLength(15);
    expect(program.statements.filter((s) => s.kind === "extend")).toHaveLength(2);
    expect(program.statements.filter((s) => s.kind === "set")).toHaveLength(5);
    expect(program.statements.filter((s) => s.kind === "validation")).toHaveLength(1);
  });

  it("parses namespace blocks containing entity declarations", () => {
    const program = parseProgram(`
      trait Location
      namespace ActOne {
        entity Cell { Location }
        entity Corridor { Location }
      }
    `);
    const namespace = program.statements.find((s) => s.kind === "namespace");
    expect(namespace).toEqual({
      kind: "namespace",
      id: "ActOne",
      entities: [
        { kind: "entity", id: "Cell", traits: ["Location"] },
        { kind: "entity", id: "Corridor", traits: ["Location"] },
      ],
      sets: [],
    });
  });

  it("parses set blocks inside namespace blocks", () => {
    const program = parseProgram(`
      trait Location
      relation Seen(Location)
      namespace ActOne {
        entity Cell { Location }
        set Seen(Cell)
      }
    `);
    const namespace = program.statements.find((s) => s.kind === "namespace");
    expect(namespace).toMatchObject({
      kind: "namespace",
      id: "ActOne",
      entities: [{ kind: "entity", id: "Cell", traits: ["Location"] }],
      sets: [
        {
          kind: "set",
          effects: [
            {
              polarity: "assert",
              atom: { relation: "Seen", args: [{ kind: "identifier", id: "Cell" }] },
            },
          ],
        },
      ],
    });
  });

  it("parses extend declarations inside namespace blocks", () => {
    const program = parseProgram(`
      trait Openable
      namespace ActOne {
        entity Bars { }
        extend Bars { Openable }
      }
    `);
    const namespace = program.statements.find((s) => s.kind === "namespace");
    expect(namespace).toMatchObject({
      kind: "namespace",
      id: "ActOne",
      entities: [{ kind: "entity", id: "Bars", traits: [] }],
      extends: [{ kind: "extend", id: "Bars", traits: ["Openable"] }],
      sets: [],
    });
  });

  it("parses qualified entity references", () => {
    const program = parseProgram(`
      trait Location
      relation Path(Location, Location)
      namespace ActOne { entity Cell { Location } }
      namespace ActTwo { entity Cell { Location } }
      set Path(ActOne.Cell, ActTwo.Cell)
    `);
    const set = program.statements.find((s) => s.kind === "set");
    if (!set || set.kind !== "set") throw new Error("missing set");
    expect(set.effects[0]?.atom.args).toEqual([
      { kind: "identifier", id: "ActOne.Cell" },
      { kind: "identifier", id: "ActTwo.Cell" },
    ]);
  });

  it("rejects unsupported declarations inside namespace blocks", () => {
    expect(() => parseProgram("namespace ActOne { trait Location }")).toThrow(
      "namespace 'ActOne' can only contain entity, extend, or set declarations",
    );
  });

  it("parses constrained action parameters", () => {
    const program = parseProgram(
      "trait Actor\ntrait Locatable\ntrait Location\naction Go(actor: (Actor & Locatable) { At(actor, ?here) }, target: Location) { when (Path(here, target)) { set At(actor, target) } }",
    );
    const go = program.statements.find((s) => s.kind === "action" && s.id === "Go");
    if (!go || go.kind !== "action") throw new Error("missing Go action");

    const actor = go.parameters[0]!;
    expect(actor.name).toBe("actor");
    expect(actor.type).toEqual({
      kind: "intersection",
      types: [
        { kind: "named", id: "Actor" },
        { kind: "named", id: "Locatable" },
      ],
    });
    expect(actor.constraints).toHaveLength(1);
    expect(actor.constraints[0]).toMatchObject({
      kind: "relation",
      atom: { relation: "At" },
    });
  });

  it("parses bare type/entity in parameter slot as a typed wildcard", () => {
    const program = parseProgram(`
      trait Actor
      entity Guard { Actor }
      action Wave(a: Actor, Guard) { succeed; }
    `);
    const wave = program.statements.find((s) => s.kind === "action" && s.id === "Wave");
    if (!wave || wave.kind !== "action") throw new Error("missing Wave action");

    const second = wave.parameters[1]!;
    expect(second.wildcard).toBe(true);
    expect(second.name).toBeUndefined();
    expect(second.type).toEqual({ kind: "named", id: "Guard" });
    expect(second.constraints).toHaveLength(0);
  });

  it("parses relation-valued terms", () => {
    const program = parseProgram(`
      relation Gated(Path, one Openable)
      set {
        Gated(Path(Cell, Corridor), Bars);
      }
    `);
    const set = program.statements.find((s) => s.kind === "set");
    if (!set || set.kind !== "set") throw new Error("missing set");
    const firstArg = set.effects[0]!.atom.args[0]!;
    expect(firstArg).toEqual({
      kind: "relationInstance",
      atom: {
        relation: "Path",
        args: [
          { kind: "identifier", id: "Cell" },
          { kind: "identifier", id: "Corridor" },
        ],
      },
    });
  });

  it("parses explicit variable terms", () => {
    const expression = language.parseExpression("At(Player, ?where)");
    expect(expression).toEqual({
      kind: "relation",
      atom: {
        relation: "At",
        args: [
          { kind: "identifier", id: "Player" },
          { kind: "variable", id: "where" },
        ],
      },
    });
  });

  it("parses named relation parameters and explicit uniqueness", () => {
    const program = parseProgram("trait Actor\ntrait Location\nrelation At(subject: Actor, location: Location) unique(subject)");
    expect(program.statements[2]).toMatchObject({
      kind: "relation",
      id: "At",
      parameters: [
        { name: "subject", type: { kind: "named", id: "Actor" } },
        { name: "location", type: { kind: "named", id: "Location" } },
      ],
      unique: ["subject"],
    });
  });

  it("parses external predicate declarations", () => {
    const program = parseProgram("trait Actor\ntrait Thing\nextern predicate CanSee(actor: Actor, target: Thing);");
    expect(program.statements[2]).toMatchObject({
      kind: "externPredicate",
      id: "CanSee",
      parameters: [
        { name: "actor", type: { kind: "named", id: "Actor" } },
        { name: "target", type: { kind: "named", id: "Thing" } },
      ],
    });
  });

  it("parses mockup menus with query-backed dynamic options", () => {
    const program = parseProgram(`
      trait Actor
      trait Location
      relation At(Actor, Location)
      action Go(actor: Actor, target: Location) { succeed; }
      mockup MainMenu(cursor: Actor { At(cursor, ?here) }) {
        title { here }
        detail {
          "visible here: " Visible(cursor)
        }
        options {
          "go" -> GoMenu(cursor)
          there: Adjacent(cursor) -> Go(cursor, there) -> MainMenu(cursor)
        }
      }
    `);
    const mockup = program.statements.find((s) => s.kind === "mockup");
    if (!mockup || mockup.kind !== "mockup") throw new Error("missing mockup");
    expect(mockup.id).toBe("MainMenu");
    expect(mockup.title).toEqual([{ kind: "identifier", id: "here" }]);
    expect(mockup.detail[0]).toMatchObject({
      kind: "line",
      terms: [
        { kind: "string", value: "visible here: " },
        { kind: "relationInstance", atom: { relation: "Visible" } },
      ],
    });
    expect(mockup.options).toHaveLength(2);
    expect(mockup.options[1]).toMatchObject({
      kind: "dynamic",
      name: "there",
      targets: [
        { relation: "Go" },
        { relation: "MainMenu" },
      ],
    });
  });

  it("parses explicit mockup start declarations", () => {
    const program = parseProgram("mockup start { MainMenu(Player) }");
    expect(program.statements).toEqual([
      {
        kind: "mockupStart",
        call: {
          relation: "MainMenu",
          args: [{ kind: "identifier", id: "Player" }],
        },
      },
    ]);
  });
});

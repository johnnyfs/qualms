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
    expect(program.statements.filter((s) => s.kind === "relation")).toHaveLength(12);
    expect(program.statements.filter((s) => s.kind === "predicate")).toHaveLength(4);
    expect(program.statements.filter((s) => s.kind === "action")).toHaveLength(12);
    expect(program.statements.filter((s) => s.kind === "rule")).toHaveLength(14);
    expect(program.statements.filter((s) => s.kind === "entity")).toHaveLength(20);
    expect(program.statements.filter((s) => s.kind === "extend")).toHaveLength(3);
    expect(program.statements.filter((s) => s.kind === "set")).toHaveLength(9);
    expect(program.statements.filter((s) => s.kind === "validation")).toHaveLength(1);
  });

  it("parses constrained action parameters", () => {
    const program = parseProgram(
      "trait Actor\ntrait Locatable\ntrait Location\naction Go(actor: (Actor & Locatable) { At(actor, ?here) }, target: Location) { when (Path(?here, target)) { set At(actor, target) } }",
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
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const __filename = fileURLToPath(import.meta.url);
const TUTORIAL_PATH = resolve(__filename, "../../specs/tutorial.qualms");

const { parseProgram } = language;

describe("tutorial language parser", () => {
  it("parses the tutorial fixture into the new top-level statement shapes", () => {
    const source = readFileSync(TUTORIAL_PATH, "utf-8");
    const program = parseProgram(source);

    expect(program.statements.filter((s) => s.kind === "trait")).toHaveLength(8);
    expect(program.statements.filter((s) => s.kind === "relation")).toHaveLength(7);
    expect(program.statements.filter((s) => s.kind === "predicate")).toHaveLength(1);
    expect(program.statements.filter((s) => s.kind === "action")).toHaveLength(8);
    expect(program.statements.filter((s) => s.kind === "rule")).toHaveLength(9);
    expect(program.statements.filter((s) => s.kind === "entity")).toHaveLength(7);
    expect(program.statements.filter((s) => s.kind === "extend")).toHaveLength(2);
    expect(program.statements.filter((s) => s.kind === "set")).toHaveLength(4);
  });

  it("parses constrained action parameters", () => {
    const program = parseProgram(
      "trait Actor\ntrait Locatable\ntrait Location\naction Go(actor: (Actor & Locatable) { At(actor, here) }, target: Location) { when (Path(here, target)) { set At(actor, target) } }",
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
});

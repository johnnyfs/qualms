import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { language } from "@quealm/qualms";
import { buildNameIndex } from "../../src/play/naming.js";
import { buildVerbTable } from "../../src/play/verbs.js";
import { parsePlayConfig } from "../../src/play/config.js";
import { infocomView } from "../../src/play/infocomView.js";
import type { ViewContext } from "../../src/play/view.js";

const { loadStoryProgram, playLanguageCall } = language;

const TUTORIAL = readFileSync(
  join(import.meta.dirname, "../../../stories/tutorial/tutorial.qualms"),
  "utf-8",
);

const CONFIG = parsePlayConfig(`
player: Player
descriptions:
  Cell: "A grim stone cell. Iron bars block the only exit."
presentations:
  BoneShard: "A bone shard lies in the dust."
  MasterKey: "A heavy master key sits on a shelf, just out of reach."
  Bars: "Iron bars seal the corridor beyond."
  Guard: "A guard slouches against the corridor wall."
`);

function setup(): ViewContext {
  const model = loadStoryProgram(TUTORIAL);
  return {
    model,
    config: CONFIG,
    names: buildNameIndex(model, CONFIG),
    verbs: buildVerbTable(model, CONFIG),
  };
}

describe("infocomView.renderTurn", () => {
  it("renders title + description + presentations on the first turn (no lastAtom)", () => {
    const ctx = setup();
    const entries = infocomView.renderTurn(ctx);
    const titles = entries.filter((e) => e.kind === "title").map((e) => e.text);
    const narratives = entries.filter((e) => e.kind === "narrative").map((e) => e.text);
    expect(titles).toEqual(["Cell"]);
    expect(narratives).toContain("A grim stone cell. Iron bars block the only exit.");
    expect(narratives).toContain("A bone shard lies in the dust.");
    // The Guard starts with the master key, so its presentation line shouldn't appear in the Cell.
    expect(narratives).not.toContain("A heavy master key sits on a shelf, just out of reach.");
    // Bars and Guard are visible across the transparent bars
    expect(narratives).toContain("Iron bars seal the corridor beyond.");
    expect(narratives).toContain("A guard slouches against the corridor wall.");
  });

  it("prepends the last-result line above the room block", () => {
    const ctx = setup();
    const atom: language.RelationAtom = {
      relation: "Take",
      args: [
        { kind: "identifier", id: "Player" },
        { kind: "identifier", id: "BoneShard" },
      ],
    };
    const result = playLanguageCall(ctx.model, atom);
    const enriched: ViewContext = { ...ctx, lastAtom: atom, lastResult: result };
    const entries = infocomView.renderTurn(enriched);
    const first = entries.find((e) => e.kind === "narrative" && e.text.length > 0);
    expect(first?.text).toBe("You take the bone shard.");
    // The room still shows the title afterwards.
    expect(entries.some((e) => e.kind === "title" && e.text === "Cell")).toBe(true);
  });

  it("emits an error entry on parse-stage error (lastError set, no lastResult)", () => {
    const ctx = setup();
    const enriched: ViewContext = { ...ctx, lastError: "I don't recognize that command." };
    const entries = infocomView.renderTurn(enriched);
    expect(entries[0]?.kind).toBe("error");
    expect(entries[0]?.text).toBe("I don't recognize that command.");
  });
});

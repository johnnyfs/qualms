import { describe, expect, it } from "vitest";
import { language } from "@quealm/qualms";
import { formatEffect, formatPlayResult, formatProgramEffects } from "../src/format.js";

const { idTerm } = language;

describe("formatEffect", () => {
  it("renders an assert effect with a leading +", () => {
    expect(
      formatEffect({
        polarity: "assert",
        fact: { relation: "At", args: [idTerm("Player"), idTerm("Corridor")] },
      }),
    ).toBe("+ At(Player, Corridor);");
  });

  it("renders a retract effect with a leading -", () => {
    expect(
      formatEffect({
        polarity: "retract",
        fact: { relation: "Locked", args: [idTerm("Bars")] },
      }),
    ).toBe("- Locked(Bars);");
  });
});

describe("formatPlayResult", () => {
  it("emits feedback followed by effects on pass", () => {
    const entries = formatPlayResult({
      status: "passed",
      feedback: "succeed;",
      reasons: [],
      effects: [
        { polarity: "assert", fact: { relation: "Opened", args: [idTerm("Bars")] } },
      ],
    });
    expect(entries).toEqual([
      { kind: "feedback", text: "succeed;" },
      { kind: "effect", text: "+ Opened(Bars);" },
    ]);
  });

  it("emits feedback alone when no effects fired", () => {
    const entries = formatPlayResult({
      status: "failed",
      feedback: "fail { Locked(Bars); }",
      reasons: ["Locked(Bars)"],
      effects: [],
    });
    expect(entries).toEqual([{ kind: "feedback", text: "fail { Locked(Bars); }" }]);
  });
});

describe("formatProgramEffects", () => {
  it("renders ok; for a definition-only program", () => {
    expect(formatProgramEffects([])).toEqual([{ kind: "feedback", text: "ok;" }]);
  });

  it("renders each effect on its own line", () => {
    const entries = formatProgramEffects([
      { polarity: "assert", fact: { relation: "At", args: [idTerm("Player"), idTerm("Cell")] } },
      { polarity: "retract", fact: { relation: "Locked", args: [idTerm("Bars")] } },
    ]);
    expect(entries).toEqual([
      { kind: "effect", text: "+ At(Player, Cell);" },
      { kind: "effect", text: "- Locked(Bars);" },
    ]);
  });
});

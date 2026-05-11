import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { language } from "@quealm/qualms";
import { handleInput } from "../src/handleInput.js";

const __filename = fileURLToPath(import.meta.url);
const TUTORIAL_PATH = resolve(__filename, "../../../stories/tutorial/tutorial.qualms");

const { loadStoryProgram } = language;

describe("handleInput", () => {
  it("plays an action call and emits feedback + effects", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));
    // The master key is with the guard in stage 9; walk to OfferAFavor to
    // receive it before unlocking.
    handleInput(model, "TalkAbout(Player, Guard, Whatever)");
    handleInput(model, "TalkAbout(Player, Guard, Bribery)");
    handleInput(model, "TalkAbout(Player, Guard, OfferAFavor)");
    const entries = handleInput(model, "Unlock(Player, Bars, MasterKey)");
    expect(entries[0]).toEqual({ kind: "feedback", text: "succeed;" });
    expect(entries).toContainEqual({ kind: "effect", text: "- Locked(Bars);" });
  });

  it("returns DSL-shaped failure feedback when an action fails", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));
    const entries = handleInput(model, "Open(Player, Bars)");
    expect(entries).toEqual([{ kind: "feedback", text: "fail { Locked(Bars); }" }]);
  });

  it("applies a set program and reports the resulting effects", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));
    const entries = handleInput(model, "set { !Locked(Bars); }");
    expect(entries).toEqual([{ kind: "effect", text: "- Locked(Bars);" }]);
  });

  it("reports ok; for a definition-only program", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));
    const entries = handleInput(model, "trait Sneaky");
    expect(entries).toEqual([{ kind: "feedback", text: "ok;" }]);
  });

  it("surfaces parse errors with the error: prefix", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));
    const entries = handleInput(model, "not even close (((");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("error");
    expect(entries[0]!.text.startsWith("error: ")).toBe(true);
  });

  it("surfaces model errors (e.g. duplicate entity) with the error: prefix", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));
    const entries = handleInput(model, "entity Player { Actor, Locatable }");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("error");
    expect(entries[0]!.text).toContain("duplicate entity");
  });

  it("walks the tutorial golden path end-to-end", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));

    expect(handleInput(model, "At(Player, Cell)")[0]).toEqual({ kind: "feedback", text: "succeed;" });

    const blocked = handleInput(model, "Go(Player, Corridor)");
    expect(blocked[0]!.kind).toBe("feedback");
    expect(blocked[0]!.text.startsWith("fail {")).toBe(true);

    // Walk the stage-9 conversation to receive the master key.
    handleInput(model, "TalkAbout(Player, Guard, Whatever)");
    handleInput(model, "TalkAbout(Player, Guard, Bribery)");
    handleInput(model, "TalkAbout(Player, Guard, OfferAFavor)");

    expect(handleInput(model, "Unlock(Player, Bars, MasterKey)")[0]).toEqual({
      kind: "feedback",
      text: "succeed;",
    });
    expect(handleInput(model, "Open(Player, Bars)")[0]).toEqual({ kind: "feedback", text: "succeed;" });

    const moved = handleInput(model, "Go(Player, Corridor)");
    expect(moved[0]).toEqual({ kind: "feedback", text: "succeed;" });
    expect(moved).toContainEqual({ kind: "effect", text: "+ At(Player, Corridor);" });
  });

  it("ignores blank input", () => {
    const model = loadStoryProgram(readFileSync(TUTORIAL_PATH, "utf-8"));
    expect(handleInput(model, "   \n\t  ")).toEqual([]);
  });
});

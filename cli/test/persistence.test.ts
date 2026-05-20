import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { language } from "@quealm/qualms";
import { defaultSaveTarget, saveStoryModel } from "../src/persistence.js";

describe("persistence helpers", () => {
  it("chooses the only loaded story as the default save target", () => {
    expect(defaultSaveTarget(["/tmp/story.qualms"])).toBe("/tmp/story.qualms");
    expect(defaultSaveTarget([])).toBeUndefined();
    expect(defaultSaveTarget(["a", "b"])).toBeUndefined();
  });

  it("writes canonical story text to the requested path", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "qualms-save-"));
    const target = join(tmpDir, "story.qualms");
    const model = language.loadStoryProgram("relation Foo()");
    const saved = saveStoryModel(model, target);
    expect(saved).toBe(target);
    expect(readFileSync(target, "utf-8")).toBe(language.emitStoryModel(model));
  });
});

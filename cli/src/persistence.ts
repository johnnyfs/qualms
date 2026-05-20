import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { language } from "@quealm/qualms";

export function defaultSaveTarget(storyPaths: readonly string[]): string | undefined {
  return storyPaths.length === 1 ? storyPaths[0] : undefined;
}

export function saveStoryModel(model: language.StoryModel, targetPath: string): string {
  const absolutePath = resolve(targetPath);
  writeFileSync(absolutePath, language.emitStoryModel(model), "utf-8");
  return absolutePath;
}

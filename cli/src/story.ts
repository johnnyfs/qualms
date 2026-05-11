import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { language } from "@quealm/qualms";

type StoryModel = language.StoryModel;

const { StoryModel: StoryModelClass, parseProgram } = language;

export interface LoadedStories {
  readonly model: StoryModel;
  readonly resolvedPaths: readonly string[];
}

export function loadStories(paths: readonly string[]): LoadedStories {
  const model = new StoryModelClass();
  const resolvedPaths: string[] = [];
  for (const path of paths) {
    const absolute = resolve(path);
    const source = readFileSync(absolute, "utf-8");
    model.apply(parseProgram(source));
    resolvedPaths.push(absolute);
  }
  return { model, resolvedPaths };
}

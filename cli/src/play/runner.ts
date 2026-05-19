import type { language } from "@quealm/qualms";

export interface PlaySession {
  readonly model: language.StoryModel;
}

export function createPlaySession(model: language.StoryModel): PlaySession {
  return { model };
}

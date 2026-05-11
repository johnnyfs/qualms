import { language } from "@quealm/qualms";
import { classifyInput } from "./dispatch.js";
import { formatPlayResult, formatProgramEffects } from "./format.js";
import type { TranscriptEntry } from "./types.js";

type StoryModel = language.StoryModel;

const { LanguageModelError, evalLanguageAtom } = language;

export function handleInput(model: StoryModel, source: string): TranscriptEntry[] {
  const trimmed = source.trim();
  if (trimmed.length === 0) return [];

  const classification = classifyInput(trimmed);
  switch (classification.kind) {
    case "call": {
      const result = evalLanguageAtom(model, classification.atom);
      return formatPlayResult(result);
    }
    case "program": {
      try {
        const effects = model.apply(classification.program);
        return formatProgramEffects(effects);
      } catch (e) {
        const message =
          e instanceof LanguageModelError ? e.message : e instanceof Error ? e.message : String(e);
        return [{ kind: "error", text: `error: ${message}` }];
      }
    }
    case "error":
      return [{ kind: "error", text: `error: ${classification.message}` }];
  }
}

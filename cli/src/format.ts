import { language } from "@quealm/qualms";
import type { TranscriptEntry } from "./types.js";

type Effect = language.Effect;
type LanguagePlayResult = language.LanguagePlayResult;

const { emitFact } = language;

export function formatEffect(effect: Effect, model?: language.StoryModel): string {
  const sign = effect.polarity === "assert" ? "+" : "-";
  return `${sign} ${formatFact(effect.fact, model)};`;
}

export function formatPlayResult(result: LanguagePlayResult, model?: language.StoryModel): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [{ kind: "feedback", text: result.feedback }];
  for (const effect of result.effects) {
    entries.push({ kind: "effect", text: formatEffect(effect, model) });
  }
  return entries;
}

export function formatProgramEffects(effects: readonly Effect[], model?: language.StoryModel): TranscriptEntry[] {
  if (effects.length === 0) return [{ kind: "feedback", text: "ok;" }];
  return effects.map((effect) => ({ kind: "effect", text: formatEffect(effect, model) }));
}

function formatFact(fact: language.Fact, model?: language.StoryModel): string {
  if (!model) return emitFact(fact);
  return `${fact.relation}(${fact.args.map((arg) => formatGroundTerm(arg, model)).join(", ")})`;
}

function formatGroundTerm(term: language.GroundTerm, model: language.StoryModel): string {
  switch (term.kind) {
    case "id":
      return model.displayEntityId(term.id);
    case "string":
      return JSON.stringify(term.value);
    case "number":
      return String(term.value);
    case "relation":
      return `${term.relation}(${term.args.map((arg) => formatGroundTerm(arg, model)).join(", ")})`;
  }
}

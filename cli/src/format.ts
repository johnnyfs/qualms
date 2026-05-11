import { language } from "@quealm/qualms";
import type { TranscriptEntry } from "./types.js";

type Effect = language.Effect;
type LanguagePlayResult = language.LanguagePlayResult;

const { emitFact } = language;

export function formatEffect(effect: Effect): string {
  const sign = effect.polarity === "assert" ? "+" : "-";
  return `${sign} ${emitFact(effect.fact)};`;
}

export function formatPlayResult(result: LanguagePlayResult): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [{ kind: "feedback", text: result.feedback }];
  for (const effect of result.effects) {
    entries.push({ kind: "effect", text: formatEffect(effect) });
  }
  return entries;
}

export function formatProgramEffects(effects: readonly Effect[]): TranscriptEntry[] {
  if (effects.length === 0) return [{ kind: "feedback", text: "ok;" }];
  return effects.map((effect) => ({ kind: "effect", text: formatEffect(effect) }));
}

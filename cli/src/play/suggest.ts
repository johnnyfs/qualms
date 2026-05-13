import type { NameIndex } from "./naming.js";
import type { VerbTable } from "./verbs.js";

export interface Suggestion {
  readonly text: string;
  readonly kind: "verb" | "noun";
}

export function suggest(
  value: string,
  verbs: VerbTable,
  names: NameIndex,
  limit = 5,
): readonly Suggestion[] {
  const lower = value.toLowerCase().trimStart();
  if (!lower) {
    return verbs
      .all()
      .filter((v) => !v.hidden)
      .flatMap((v) =>
        v.words.map((w): Suggestion => ({ text: w, kind: "verb" })),
      )
      .slice(0, limit);
  }

  const hit = verbs.lookup(lower);
  if (!hit) {
    const seen = new Set<string>();
    const matches: Suggestion[] = [];
    for (const verb of verbs.all()) {
      if (verb.hidden) continue;
      for (const word of verb.words) {
        if (seen.has(word)) continue;
        if (word.startsWith(lower)) {
          seen.add(word);
          matches.push({ text: word, kind: "verb" });
          if (matches.length >= limit) return matches;
        }
      }
    }
    return matches;
  }

  // Verb matched. Suggest noun completions for the tail.
  const tail = hit.tail.toLowerCase().trimStart();
  const nouns = names.allNouns();
  if (!tail) {
    return nouns
      .slice(0, limit)
      .map((n): Suggestion => ({ text: `${hit.word} ${n.name}`, kind: "noun" }));
  }
  return nouns
    .filter((n) => n.name.startsWith(tail))
    .slice(0, limit)
    .map((n): Suggestion => ({ text: `${hit.word} ${n.name}`, kind: "noun" }));
}

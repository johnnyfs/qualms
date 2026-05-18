import type { language } from "@quealm/qualms";
import { defaultDisplayName } from "./naming.js";
import type { PlayConfig } from "./config.js";

type ParameterPattern = NonNullable<
  ReturnType<language.StoryModel["actions"]["get"]>
>["parameters"][number];

export type VerbKind = "action" | "query";

export interface VerbEntry {
  readonly actionId: string;
  readonly kind: VerbKind;
  readonly words: readonly string[];
  readonly parameters: readonly ParameterPattern[];
  readonly prepositions: ReadonlyMap<number, string>;
  readonly candidates: ReadonlyMap<number, string>;
  readonly template?: string;
  readonly hidden: boolean;
}

export interface VerbMatch {
  readonly verb: VerbEntry;
  readonly word: string;
  readonly tail: string;
}

export interface VerbTable {
  lookup(text: string): VerbMatch | undefined;
  all(): readonly VerbEntry[];
  getById(id: string): VerbEntry | undefined;
}

interface IndexEntry {
  readonly verb: VerbEntry;
  readonly word: string;
  readonly tokenCount: number;
}

export function buildVerbTable(
  model: language.StoryModel,
  config: PlayConfig,
): VerbTable {
  const verbs: VerbEntry[] = [];
  const addEntry = (
    id: string,
    kind: VerbKind,
    parameters: readonly ParameterPattern[],
  ) => {
    const override = config.verbs.get(id);
    const words = normalizeWords(override?.words ?? [defaultDisplayName(id)]);
    verbs.push({
      actionId: id,
      kind,
      words,
      parameters,
      prepositions: override?.prepositions ?? new Map(),
      candidates: override?.candidates ?? new Map(),
      ...(override?.template !== undefined ? { template: override.template } : {}),
      hidden: override?.hidden ?? false,
    });
  };
  for (const [id, action] of model.actions) addEntry(id, "action", action.parameters);
  for (const [id, query] of model.queries) addEntry(id, "query", query.parameters);
  verbs.sort((a, b) => a.actionId.localeCompare(b.actionId));

  const index: IndexEntry[] = [];
  for (const verb of verbs) {
    for (const word of verb.words) {
      index.push({ verb, word, tokenCount: word.split(/\s+/).length });
    }
  }
  // longest-token match first; tiebreak alphabetic for determinism.
  index.sort(
    (a, b) => b.tokenCount - a.tokenCount || a.word.localeCompare(b.word),
  );

  const byId = new Map<string, VerbEntry>();
  for (const verb of verbs) byId.set(verb.actionId, verb);

  return {
    lookup(text) {
      const normalized = text.trim().toLowerCase();
      if (!normalized) return undefined;
      for (const entry of index) {
        const match = matchPrefix(normalized, entry.word);
        if (match === undefined) continue;
        return { verb: entry.verb, word: entry.word, tail: match };
      }
      return undefined;
    },
    all() {
      return verbs;
    },
    getById(id) {
      return byId.get(id);
    },
  };
}

function normalizeWords(words: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of words) {
    const cleaned = word.trim().replace(/\s+/g, " ").toLowerCase();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function matchPrefix(text: string, surface: string): string | undefined {
  if (text === surface) return "";
  if (text.startsWith(surface + " ")) return text.slice(surface.length + 1).trimStart();
  return undefined;
}

import type { language } from "@quealm/qualms";
import type { PlayConfig } from "./config.js";
import type { NameIndex } from "./naming.js";
import type { VerbEntry, VerbTable } from "./verbs.js";

type RelationAtom = language.RelationAtom;

export type ParseOutcome = ParseSuccess | ParseError;

export interface ParseSuccess {
  readonly kind: "ok";
  readonly verb: VerbEntry;
  readonly atom: RelationAtom;
}

export type ParseError =
  | { readonly kind: "empty" }
  | { readonly kind: "unknown_verb"; readonly text: string }
  | {
      readonly kind: "missing_preposition";
      readonly preposition: string;
      readonly slot: number;
    }
  | {
      readonly kind: "missing_noun";
      readonly slot: number;
      readonly parameterName?: string;
    }
  | {
      readonly kind: "unknown_noun";
      readonly phrase: string;
      readonly slot: number;
    }
  | {
      readonly kind: "ambiguous_noun";
      readonly phrase: string;
      readonly slot: number;
      readonly candidates: readonly string[];
    }
  | {
      readonly kind: "trailing_text";
      readonly text: string;
    };

export function parsePlayInput(
  text: string,
  options: {
    readonly verbs: VerbTable;
    readonly names: NameIndex;
    readonly config: PlayConfig;
  },
): ParseOutcome {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };

  const lookup = options.verbs.lookup(trimmed);
  if (!lookup) return { kind: "unknown_verb", text: trimmed };

  const { verb, tail } = lookup;
  const params = verb.parameters;
  if (params.length === 0) {
    return {
      kind: "ok",
      verb,
      atom: { relation: verb.actionId, args: [] },
    };
  }

  // Implicit-player rule: param[0] is the actor and is filled with config.player.
  // We do not type-filter — domain validity (is-an-actor, etc.) is the DSL's job.
  const [, ...slots] = params;

  const split = splitSlots(tail, slots.length, verb.prepositions);
  if (split.kind !== "ok") return split;
  const phraseList = split.phrases;

  const resolvedArgs: language.Term[] = [
    { kind: "identifier", id: options.config.player },
  ];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const phrase = phraseList[i] ?? "";
    if (!phrase) {
      return {
        kind: "missing_noun",
        slot: i,
        ...(slot.name ? { parameterName: slot.name } : {}),
      };
    }
    const candidates = options.names.resolveNoun(phrase);
    if (candidates.length === 0) {
      return { kind: "unknown_noun", phrase, slot: i };
    }
    if (candidates.length > 1) {
      return { kind: "ambiguous_noun", phrase, slot: i, candidates };
    }
    resolvedArgs.push({ kind: "identifier", id: candidates[0]! });
  }

  return {
    kind: "ok",
    verb,
    atom: { relation: verb.actionId, args: resolvedArgs },
  };
}

interface SlotSplitOk {
  readonly kind: "ok";
  readonly phrases: readonly string[];
}

function splitSlots(
  tail: string,
  count: number,
  prepositions: ReadonlyMap<number, string>,
): SlotSplitOk | ParseError {
  let rest = tail.trim();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const myPrep = prepositions.get(i);
    if (myPrep !== undefined) {
      const stripped = stripLeadingWord(rest, myPrep);
      if (stripped === undefined) {
        return { kind: "missing_preposition", preposition: myPrep, slot: i };
      }
      rest = stripped;
    }
    const nextPrep = i + 1 < count ? prepositions.get(i + 1) : undefined;
    if (nextPrep !== undefined) {
      const idx = findWordIndex(rest, nextPrep);
      if (idx < 0) {
        return { kind: "missing_preposition", preposition: nextPrep, slot: i + 1 };
      }
      out.push(rest.slice(0, idx).trim());
      rest = rest.slice(idx).trim();
    } else {
      out.push(rest.trim());
      rest = "";
    }
  }
  if (rest.length > 0) {
    return { kind: "trailing_text", text: rest };
  }
  return { kind: "ok", phrases: out };
}

function stripLeadingWord(text: string, word: string): string | undefined {
  const t = text.trim();
  const w = word.trim().toLowerCase();
  const lower = t.toLowerCase();
  if (lower === w) return "";
  if (lower.startsWith(w + " ")) return t.slice(w.length + 1).trimStart();
  return undefined;
}

function findWordIndex(text: string, word: string): number {
  const lower = text.toLowerCase();
  const w = word.toLowerCase();
  let i = 0;
  while (i <= lower.length - w.length) {
    const at = lower.indexOf(w, i);
    if (at < 0) return -1;
    const before = at === 0 || /\s/.test(text[at - 1]!);
    const afterIdx = at + w.length;
    const after = afterIdx === text.length || /\s/.test(text[afterIdx]!);
    if (before && after) return at;
    i = at + 1;
  }
  return -1;
}


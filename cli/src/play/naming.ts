import type { language } from "@quealm/qualms";
import type { PlayConfig } from "./config.js";

export function tokenizeCamelCase(id: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  for (let i = 0; i < id.length; i++) {
    const c = id[i]!;
    const prev = id[i - 1];
    const next = id[i + 1];
    const isUpper = c >= "A" && c <= "Z";
    const prevIsLower = prev !== undefined && prev >= "a" && prev <= "z";
    const nextIsLower = next !== undefined && next >= "a" && next <= "z";
    const isBoundary = isUpper && i > 0 && (prevIsLower || nextIsLower);
    if (isBoundary) {
      if (buf) tokens.push(buf);
      buf = c;
    } else {
      buf += c;
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

export function defaultDisplayName(id: string): string {
  return tokenizeCamelCase(id)
    .map((t) => t.toLowerCase())
    .join(" ");
}

export function titleCase(text: string): string {
  return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

export interface NameIndex {
  displayName(id: string): string;
  titleName(id: string): string;
  resolveNoun(phrase: string): readonly string[];
  allNouns(): readonly NounEntry[];
}

export interface NounEntry {
  readonly name: string;
  readonly id: string;
}

export function buildNameIndex(model: language.StoryModel, config: PlayConfig): NameIndex {
  const idToName = new Map<string, string>();
  const nameToIds = new Map<string, string[]>();

  const addSurface = (surface: string, id: string) => {
    const key = normalize(surface);
    if (!key) return;
    const bucket = nameToIds.get(key);
    if (bucket) {
      if (!bucket.includes(id)) bucket.push(id);
    } else {
      nameToIds.set(key, [id]);
    }
  };

  for (const id of model.entities.keys()) {
    const display = config.names.get(id) ?? defaultDisplayName(id);
    idToName.set(id, display);
    addSurface(display, id);
    const extras = config.synonyms.get(id);
    if (extras) for (const synonym of extras) addSurface(synonym, id);
  }

  return {
    displayName(id) {
      return idToName.get(id) ?? defaultDisplayName(id);
    },
    titleName(id) {
      return titleCase(idToName.get(id) ?? defaultDisplayName(id));
    },
    resolveNoun(phrase) {
      const key = normalize(phrase);
      const hit = nameToIds.get(key);
      if (!hit) return [];
      return [...hit].sort();
    },
    allNouns() {
      const out: NounEntry[] = [];
      for (const [name, ids] of nameToIds) {
        for (const id of ids) out.push({ name, id });
      }
      out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      return out;
    },
  };
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

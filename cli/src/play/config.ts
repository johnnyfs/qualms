import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { language } from "@quealm/qualms";

export interface PlayConfig {
  readonly player: string;
  readonly names: ReadonlyMap<string, string>;
  readonly synonyms: ReadonlyMap<string, readonly string[]>;
  readonly descriptions: ReadonlyMap<string, string>;
  readonly presentations: ReadonlyMap<string, string>;
  readonly visibility: {
    readonly predicate: string;
    readonly locationFact: string;
  };
  readonly verbs: ReadonlyMap<string, VerbConfig>;
  readonly queries: ReadonlyMap<string, QueryConfig>;
  readonly events: ReadonlyMap<string, string>;
  readonly view: { readonly kind: "menu" | "infocom" };
  readonly conversation: {
    readonly startVerb: string;
    readonly navigateVerb: string;
    readonly switchVerb: string;
    readonly stopVerb: string;
    readonly topicsQuery: string;
    readonly currentTopicQuery: string;
    readonly previousTopicQuery: string;
  };
  readonly source?: string;
}

export interface VerbConfig {
  readonly words?: readonly string[];
  readonly prepositions?: ReadonlyMap<number, string>;
  readonly template?: string;
  readonly denialTemplate?: string;
  readonly hidden?: boolean;
}

export interface QueryConfig {
  readonly template?: string;
  readonly empty?: string;
  readonly item?: string;
  readonly join?: string;
}

export class PlayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlayConfigError";
  }
}

export function defaultPlayConfig(player = "Player"): PlayConfig {
  return {
    player,
    names: new Map(),
    synonyms: new Map(),
    descriptions: new Map(),
    presentations: new Map(),
    visibility: { predicate: "IsVisibleTo", locationFact: "At" },
    verbs: new Map(),
    queries: new Map(),
    events: new Map(),
    view: { kind: "menu" },
    conversation: {
      startVerb: "TalkTo",
      navigateVerb: "TalkAbout",
      switchVerb: "SwitchTopics",
      stopVerb: "StopTalking",
      topicsQuery: "Topics",
      currentTopicQuery: "CurrentTopic",
      previousTopicQuery: "PreviousTopic",
    },
  };
}

export function discoverPlayConfigPath(storyPath: string): string | undefined {
  const dir = dirname(storyPath);
  const base = basename(storyPath).replace(/\.qualms$/, "");
  const candidate = join(dir, `${base}.play.yaml`);
  return existsSync(candidate) ? candidate : undefined;
}

export function loadPlayConfig(path: string): PlayConfig {
  const text = readFileSync(path, "utf-8");
  return parsePlayConfig(text, path);
}

export function parsePlayConfig(text: string, source?: string): PlayConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new PlayConfigError(`invalid YAML: ${message}`);
  }
  if (raw === null || raw === undefined) {
    return source ? { ...defaultPlayConfig(), source } : defaultPlayConfig();
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlayConfigError("play config must be a YAML mapping");
  }
  const obj = raw as Record<string, unknown>;

  const player = typeof obj.player === "string" && obj.player.length > 0 ? obj.player : "Player";
  const names = readStringMap(obj.names, "names");
  const synonyms = readStringArrayMap(obj.synonyms, "synonyms");
  const descriptions = readStringMap(obj.descriptions, "descriptions");
  const presentations = readStringMap(obj.presentations, "presentations");
  const verbs = readVerbMap(obj.verbs);
  const queries = readQueryMap(obj.queries);
  const events = readStringMap(obj.events, "events");
  const visibility = readVisibility(obj.visibility);
  const view = readView(obj.view);
  const conversation = readConversation(obj.conversation);

  return {
    player,
    names,
    synonyms,
    descriptions,
    presentations,
    visibility,
    verbs,
    queries,
    events,
    view,
    conversation,
    ...(source ? { source } : {}),
  };
}

export function validatePlayConfig(
  config: PlayConfig,
  model: language.StoryModel,
): readonly string[] {
  const warnings: string[] = [];
  if (!model.entities.has(config.player)) {
    warnings.push(`play config: player '${config.player}' is not a declared entity`);
  }
  const checkEntityMap = (map: ReadonlyMap<string, unknown>, label: string) => {
    for (const id of map.keys()) {
      if (!model.entities.has(id)) {
        warnings.push(`play config: ${label}.${id} is not a declared entity`);
      }
    }
  };
  checkEntityMap(config.names, "names");
  checkEntityMap(config.synonyms, "synonyms");
  checkEntityMap(config.descriptions, "descriptions");
  checkEntityMap(config.presentations, "presentations");
  for (const id of config.verbs.keys()) {
    if (!model.actions.has(id) && !model.queries.has(id)) {
      warnings.push(`play config: verbs.${id} is not a declared action or query`);
    }
  }
  if (
    config.visibility.predicate !== "IsVisibleTo" &&
    !model.predicates.has(config.visibility.predicate)
  ) {
    warnings.push(
      `play config: visibility.predicate '${config.visibility.predicate}' is not a declared predicate`,
    );
  }
  if (!model.relations.has(config.visibility.locationFact)) {
    warnings.push(
      `play config: visibility.locationFact '${config.visibility.locationFact}' is not a declared relation`,
    );
  }
  return warnings;
}

function readStringMap(raw: unknown, label: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlayConfigError(`play config: ${label} must be a mapping`);
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "string") {
      throw new PlayConfigError(`play config: ${label}.${k} must be a string`);
    }
    out.set(k, v);
  }
  return out;
}

function readStringArrayMap(
  raw: unknown,
  label: string,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlayConfigError(`play config: ${label} must be a mapping`);
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
      throw new PlayConfigError(`play config: ${label}.${k} must be a list of strings`);
    }
    out.set(k, v as readonly string[]);
  }
  return out;
}

function readVerbMap(raw: unknown): ReadonlyMap<string, VerbConfig> {
  const out = new Map<string, VerbConfig>();
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlayConfigError("play config: verbs must be a mapping");
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new PlayConfigError(`play config: verbs.${k} must be a mapping`);
    }
    const entry = v as Record<string, unknown>;
    const verb: VerbConfig = {};
    if (entry.words !== undefined) {
      if (!Array.isArray(entry.words) || !entry.words.every((x) => typeof x === "string")) {
        throw new PlayConfigError(`play config: verbs.${k}.words must be a list of strings`);
      }
      (verb as { words?: readonly string[] }).words = entry.words as readonly string[];
    }
    if (entry.prepositions !== undefined) {
      if (
        entry.prepositions === null ||
        typeof entry.prepositions !== "object" ||
        Array.isArray(entry.prepositions)
      ) {
        throw new PlayConfigError(`play config: verbs.${k}.prepositions must be a mapping`);
      }
      const prep = new Map<number, string>();
      for (const [pi, pv] of Object.entries(entry.prepositions as Record<string, unknown>)) {
        const idx = Number(pi);
        if (!Number.isInteger(idx) || idx < 0) {
          throw new PlayConfigError(
            `play config: verbs.${k}.prepositions key '${pi}' must be a non-negative integer`,
          );
        }
        if (typeof pv !== "string") {
          throw new PlayConfigError(`play config: verbs.${k}.prepositions.${pi} must be a string`);
        }
        prep.set(idx, pv);
      }
      (verb as { prepositions?: ReadonlyMap<number, string> }).prepositions = prep;
    }
    if (entry.template !== undefined) {
      if (typeof entry.template !== "string") {
        throw new PlayConfigError(`play config: verbs.${k}.template must be a string`);
      }
      (verb as { template?: string }).template = entry.template;
    }
    if (entry.denialTemplate !== undefined) {
      if (typeof entry.denialTemplate !== "string") {
        throw new PlayConfigError(`play config: verbs.${k}.denialTemplate must be a string`);
      }
      (verb as { denialTemplate?: string }).denialTemplate = entry.denialTemplate;
    }
    if (entry.hidden !== undefined) {
      if (typeof entry.hidden !== "boolean") {
        throw new PlayConfigError(`play config: verbs.${k}.hidden must be a boolean`);
      }
      (verb as { hidden?: boolean }).hidden = entry.hidden;
    }
    out.set(k, verb);
  }
  return out;
}

function readQueryMap(raw: unknown): ReadonlyMap<string, QueryConfig> {
  const out = new Map<string, QueryConfig>();
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlayConfigError("play config: queries must be a mapping");
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new PlayConfigError(`play config: queries.${k} must be a mapping`);
    }
    const entry = v as Record<string, unknown>;
    const query: QueryConfig = {};
    for (const field of ["template", "empty", "item", "join"] as const) {
      const value = entry[field];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        throw new PlayConfigError(`play config: queries.${k}.${field} must be a string`);
      }
      (query as Record<string, string>)[field] = value;
    }
    out.set(k, query);
  }
  return out;
}

function readVisibility(raw: unknown): PlayConfig["visibility"] {
  if (raw === undefined || raw === null) {
    return { predicate: "IsVisibleTo", locationFact: "At" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlayConfigError("play config: visibility must be a mapping");
  }
  const obj = raw as Record<string, unknown>;
  const predicate =
    obj.predicate !== undefined ? expectString(obj.predicate, "visibility.predicate") : "IsVisibleTo";
  const locationFact =
    obj.locationFact !== undefined
      ? expectString(obj.locationFact, "visibility.locationFact")
      : "At";
  return { predicate, locationFact };
}

function readView(raw: unknown): PlayConfig["view"] {
  if (raw === undefined || raw === null) return { kind: "menu" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlayConfigError("play config: view must be a mapping");
  }
  const kind = (raw as Record<string, unknown>).kind;
  if (kind === undefined) return { kind: "menu" };
  if (kind !== "menu" && kind !== "infocom") {
    throw new PlayConfigError(
      `play config: view.kind '${String(kind)}' is not supported (must be 'menu' or 'infocom')`,
    );
  }
  return { kind };
}

function readConversation(raw: unknown): PlayConfig["conversation"] {
  const defaults: PlayConfig["conversation"] = {
    startVerb: "TalkTo",
    navigateVerb: "TalkAbout",
    switchVerb: "SwitchTopics",
    stopVerb: "StopTalking",
    topicsQuery: "Topics",
    currentTopicQuery: "CurrentTopic",
    previousTopicQuery: "PreviousTopic",
  };
  if (raw === undefined || raw === null) return defaults;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlayConfigError("play config: conversation must be a mapping");
  }
  const obj = raw as Record<string, unknown>;
  const out = { ...defaults };
  for (const field of [
    "startVerb",
    "navigateVerb",
    "switchVerb",
    "stopVerb",
    "topicsQuery",
    "currentTopicQuery",
    "previousTopicQuery",
  ] as const) {
    const value = obj[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) {
      throw new PlayConfigError(`play config: conversation.${field} must be a non-empty string`);
    }
    (out as Record<string, string>)[field] = value;
  }
  return out;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new PlayConfigError(`play config: ${label} must be a string`);
  }
  return value;
}

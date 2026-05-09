/**
 * YAML loader — parses prelude/story files into the engine's typed
 * GameDefinition. Each loaded definition / entity / fact is tagged with the
 * caller-supplied layer (prelude | game | session).
 *
 * Predicate bodies are translated to query AST via predicate.ts. Effect lists
 * (set_field, assert, emit, ...) are preserved as opaque records on the
 * relation/action/rule definitions; the action engine consumes them later.
 */

import { readFileSync } from "node:fs";
import * as YAML from "js-yaml";
import { GameDefinition } from "../core/definition.js";
import {
  action as actionDef,
  attachment,
  entitySpec,
  field as fieldDef,
  kind as kindDef,
  parameter as paramDef,
  pattern as patternHelper,
  relation as relationDef,
  rule as ruleDef,
  trait as traitDef,
} from "../core/builders.js";
import type {
  ActionDefinition,
  EffectSpec,
  EntitySpec,
  FieldDefinition,
  KindDefinition,
  Module,
  ParameterDefinition,
  RelationDefinition,
  Rule,
  RuleControl,
  RulePhase,
  TraitAttachment,
  TraitDefinition,
} from "../core/types.js";
import { translatePredicate } from "./predicate.js";

export class YamlLoadError extends Error {
  constructor(message: string, public readonly path: string) {
    super(`${path}: ${message}`);
    this.name = "YamlLoadError";
  }
}

interface LoadOptions {
  module: Module;
  /** Optional file path used in error messages. */
  source?: string;
}

export function loadYamlIntoDefinition(
  def: GameDefinition,
  yamlText: string,
  options: LoadOptions,
): void {
  const root = YAML.load(yamlText, { schema: YAML.JSON_SCHEMA });
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new YamlLoadError("root must be a mapping", options.source ?? "<input>");
  }
  loadParsed(def, root as Record<string, unknown>, options);
}

export function loadFileIntoDefinition(
  def: GameDefinition,
  filePath: string,
  module: Module,
): void {
  const text = readFileSync(filePath, "utf-8");
  loadYamlIntoDefinition(def, text, { module, source: filePath });
}

export function loadParsed(
  def: GameDefinition,
  root: Record<string, unknown>,
  options: LoadOptions,
): void {
  const path = options.source ?? "<input>";
  // Top-level: qualms version, id, definitions, plus optional story-only blocks.
  const definitions = root["definitions"];
  if (definitions !== undefined) {
    if (typeof definitions !== "object" || definitions === null) {
      throw new YamlLoadError("definitions must be a mapping", path);
    }
    loadDefinitionsBlock(def, definitions as Record<string, unknown>, options);
  }
  // Story-only sections: entities, assertions, facts. (start metadata loaded too.)
  const story = root["story"];
  if (story !== undefined) {
    if (typeof story !== "object" || story === null) {
      throw new YamlLoadError("story must be a mapping", path);
    }
    loadStoryBlock(def, story as Record<string, unknown>, options);
  }
  // Top-level entities/assertions/facts (some preludes/stories use this layout too)
  const directEntities = root["entities"];
  if (directEntities !== undefined) {
    loadEntities(def, ensureArray(directEntities, `${path}.entities`), options);
  }
  const directAssertions = root["assertions"];
  if (directAssertions !== undefined) {
    loadAssertions(def, ensureArray(directAssertions, `${path}.assertions`), options);
  }
  const directFacts = root["facts"];
  if (directFacts !== undefined) {
    loadFacts(def, ensureArray(directFacts, `${path}.facts`), options);
  }
  const start = root["start"];
  if (start !== undefined) {
    if (typeof start !== "object" || start === null) {
      throw new YamlLoadError("start must be a mapping", path);
    }
    for (const [k, v] of Object.entries(start as Record<string, unknown>)) {
      def.setMetadata(options.module, `start.${k}`, v);
    }
  }
}

function loadDefinitionsBlock(
  def: GameDefinition,
  block: Record<string, unknown>,
  options: LoadOptions,
): void {
  const path = options.source ?? "<input>";
  const traits = block["traits"];
  if (traits !== undefined) {
    for (const t of ensureArray(traits, `${path}.definitions.traits`)) {
      def.addTrait(translateTrait(t, options.module, path));
    }
  }
  const relations = block["relations"];
  if (relations !== undefined) {
    for (const r of ensureArray(relations, `${path}.definitions.relations`)) {
      def.addRelation(translateRelation(r, options.module, path));
    }
  }
  const actions = block["actions"];
  if (actions !== undefined) {
    for (const a of ensureArray(actions, `${path}.definitions.actions`)) {
      def.addAction(translateAction(a, options.module, path));
    }
  }
  const rulebooks = block["rulebooks"];
  if (rulebooks !== undefined) {
    for (const rb of ensureArray(rulebooks, `${path}.definitions.rulebooks`)) {
      const obj = rb as Record<string, unknown>;
      const rulebookId = obj["id"] as string | undefined;
      if (rulebookId !== undefined) {
        // Register the rulebook itself so `def rule R in B` references resolve
        // and meta-queries see it.
        if (!def.hasRulebook(rulebookId)) {
          def.addRulebook({ id: rulebookId, module: options.module });
        }
      }
      const rules = ensureArray(obj["rules"], `${path}.rulebooks.rules`);
      for (const r of rules) {
        const rule = translateRule(r, options.module, path, rulebookId);
        def.addRule(rule);
      }
    }
  }
  const kinds = block["kinds"];
  if (kinds !== undefined) {
    for (const k of ensureArray(kinds, `${path}.definitions.kinds`)) {
      def.addKind(translateKind(k, options.module, path));
    }
  }
}

function loadStoryBlock(
  def: GameDefinition,
  story: Record<string, unknown>,
  options: LoadOptions,
): void {
  const path = options.source ?? "<input>";
  if (story["entities"] !== undefined) {
    loadEntities(def, ensureArray(story["entities"], `${path}.story.entities`), options);
  }
  if (story["assertions"] !== undefined) {
    loadAssertions(def, ensureArray(story["assertions"], `${path}.story.assertions`), options);
  }
  if (story["facts"] !== undefined) {
    loadFacts(def, ensureArray(story["facts"], `${path}.story.facts`), options);
  }
  if (story["start"] !== undefined) {
    const start = story["start"] as Record<string, unknown>;
    for (const [k, v] of Object.entries(start)) {
      def.setMetadata(options.module, `start.${k}`, v);
    }
  }
}

// ──────── Node translators ────────

function translateTrait(node: unknown, module: Module, path: string): TraitDefinition {
  const obj = ensureMapping(node, `${path} (trait)`);
  if (typeof obj["id"] !== "string") {
    throw new YamlLoadError("trait must have id", path);
  }
  const id = obj["id"];
  const params: ParameterDefinition[] = (obj["params"] as unknown[] | undefined)?.map((p, i) =>
    translateParameter(p, `${path}.${id}.params[${i}]`),
  ) ?? [];
  const fields: FieldDefinition[] = (obj["fields"] as unknown[] | undefined)?.map((f, i) =>
    translateField(f, `${path}.${id}.fields[${i}]`),
  ) ?? [];
  const relations: RelationDefinition[] = (obj["relations"] as unknown[] | undefined)?.map((r, i) =>
    translateRelation(r, module, `${path}.${id}.relations[${i}]`),
  ) ?? [];
  const actions: ActionDefinition[] = (obj["actions"] as unknown[] | undefined)?.map((a, i) =>
    translateAction(a, module, `${path}.${id}.actions[${i}]`),
  ) ?? [];
  const rules: Rule[] = (obj["rules"] as unknown[] | undefined)?.map((r, i) =>
    translateRule(r, module, `${path}.${id}.rules[${i}]`),
  ) ?? [];
  return traitDef(id, module, { parameters: params, fields, relations, actions, rules });
}

function translateRelation(
  node: unknown,
  module: Module,
  path: string,
): RelationDefinition {
  const obj = ensureMapping(node, `${path} (relation)`);
  if (typeof obj["id"] !== "string") {
    throw new YamlLoadError("relation must have id", path);
  }
  const id = obj["id"];
  const params = (obj["params"] as unknown[] | undefined)?.map((p, i) =>
    translateParameter(p, `${path}.${id}.params[${i}]`),
  ) ?? [];
  if (Object.prototype.hasOwnProperty.call(obj, "persistence")) {
    throw new YamlLoadError(
      "`persistence` is no longer supported; relations are stored by default and derived when a `get` body is present",
      path,
    );
  }
  const options: {
    get?: unknown;
    setEffects?: readonly EffectSpec[];
  } = {};
  if (obj["get"] !== undefined) {
    options.get = translatePredicate(obj["get"], `${path}.${id}.get`);
  }
  if (obj["set"] !== undefined) {
    options.setEffects = ensureArray(obj["set"], `${path}.${id}.set`).map(
      (e) => e as EffectSpec,
    );
  }
  return relationDef(id, module, params, options);
}

function translateAction(node: unknown, module: Module, path: string): ActionDefinition {
  const obj = ensureMapping(node, `${path} (action)`);
  if (typeof obj["id"] !== "string") {
    throw new YamlLoadError("action must have id", path);
  }
  const id = obj["id"];
  const params = (obj["params"] as unknown[] | undefined)?.map((p, i) =>
    translateParameter(p, `${path}.${id}.params[${i}]`),
  ) ?? [];
  const requires =
    obj["requires"] === undefined
      ? true
      : translatePredicate(obj["requires"], `${path}.${id}.requires`);
  const defaultEffects = ((obj["default"] as unknown[] | undefined) ?? []).map(
    (e) => e as EffectSpec,
  );
  return actionDef(id, module, params, { requires, defaultEffects });
}

function translateRule(
  node: unknown,
  module: Module,
  path: string,
  rulebookId?: string,
): Rule {
  const obj = ensureMapping(node, `${path} (rule)`);
  if (typeof obj["id"] !== "string") {
    throw new YamlLoadError("rule must have id", path);
  }
  if (typeof obj["phase"] !== "string") {
    throw new YamlLoadError("rule must have phase", path);
  }
  const id = obj["id"];
  const phase = obj["phase"] as RulePhase;
  const match = obj["match"] as Record<string, unknown> | undefined;
  if (!match || typeof match["action"] !== "string") {
    throw new YamlLoadError("rule.match.action must be a string", path);
  }
  const args: Record<string, unknown> = (match["args"] as Record<string, unknown> | undefined) ?? {};
  const guard =
    obj["guard"] === undefined
      ? true
      : translatePredicate(obj["guard"], `${path}.${id}.guard`);
  const effects = ((obj["effects"] as unknown[] | undefined) ?? []).map((e) => e as EffectSpec);
  const control = (obj["control"] as RuleControl | undefined) ?? "continue";
  const priority = (obj["priority"] as number | undefined) ?? 0;
  return ruleDef(id, module, phase, {
    pattern: patternHelper(match["action"] as string, args),
    effects,
    guard,
    control,
    priority,
    ...(rulebookId !== undefined ? { rulebook: rulebookId } : {}),
  });
}

function translateKind(node: unknown, module: Module, path: string): KindDefinition {
  const obj = ensureMapping(node, `${path} (kind)`);
  if (typeof obj["id"] !== "string") {
    throw new YamlLoadError("kind must have id", path);
  }
  const id = obj["id"];
  const traits = (obj["traits"] as unknown[] | undefined)?.map((t, i) =>
    translateAttachment(t, `${path}.${id}.traits[${i}]`),
  ) ?? [];
  const fields: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries((obj["fields"] as Record<string, unknown> | undefined) ?? {})) {
    fields[k] = v as Record<string, unknown>;
  }
  const rules = (obj["rules"] as unknown[] | undefined)?.map((r, i) =>
    translateRule(r, module, `${path}.${id}.rules[${i}]`),
  ) ?? [];
  return kindDef(id, module, { traits, fields, rules });
}

function translateAttachment(node: unknown, path: string): TraitAttachment {
  if (typeof node === "string") return attachment(node);
  const obj = ensureMapping(node, path);
  if (typeof obj["id"] !== "string") {
    throw new YamlLoadError("trait attachment must have id (or be a bare string)", path);
  }
  const id = obj["id"];
  const params = (obj["params"] as Record<string, unknown> | undefined) ?? {};
  const fields = (obj["fields"] as Record<string, unknown> | undefined) ?? {};
  return attachment(id, { parameters: params, fields });
}

function translateParameter(node: unknown, path: string): ParameterDefinition {
  const obj = ensureMapping(node, path);
  if (typeof obj["id"] !== "string") {
    throw new YamlLoadError("parameter must have id", path);
  }
  const opts: { type?: string; default?: unknown; hasDefault?: boolean } = {};
  if (typeof obj["type"] === "string") opts.type = obj["type"];
  if (Object.prototype.hasOwnProperty.call(obj, "default")) {
    opts.default = obj["default"];
    opts.hasDefault = true;
  }
  return paramDef(obj["id"], opts);
}

function translateField(node: unknown, path: string): FieldDefinition {
  const obj = ensureMapping(node, path);
  if (typeof obj["id"] !== "string") {
    throw new YamlLoadError("field must have id", path);
  }
  const opts: { type?: string; default?: unknown; hasDefault?: boolean } = {};
  if (typeof obj["type"] === "string") opts.type = obj["type"];
  if (Object.prototype.hasOwnProperty.call(obj, "default")) {
    opts.default = obj["default"];
    opts.hasDefault = true;
  }
  return fieldDef(obj["id"], opts);
}

// ──────── Story-section loaders ────────

function loadEntities(def: GameDefinition, list: unknown[], options: LoadOptions): void {
  const path = options.source ?? "<input>";
  for (const node of list) {
    const obj = ensureMapping(node, `${path} (entity)`);
    if (typeof obj["id"] !== "string") {
      throw new YamlLoadError("entity must have id", path);
    }
    const id = obj["id"];
    const kind = typeof obj["kind"] === "string" ? obj["kind"] : undefined;
    const traits = (obj["traits"] as unknown[] | undefined)?.map((t, i) =>
      translateAttachment(t, `${path}.entities.${id}.traits[${i}]`),
    ) ?? [];
    const fields: Record<string, Record<string, unknown>> = {};
    for (const [k, v] of Object.entries((obj["fields"] as Record<string, unknown> | undefined) ?? {})) {
      fields[k] = v as Record<string, unknown>;
    }
    const rules: Rule[] = (obj["rules"] as unknown[] | undefined)?.map((r, i) =>
      translateRule(r, options.module, `${path}.entities.${id}.rules[${i}]`),
    ) ?? [];
    const metadata = (obj["metadata"] as Record<string, unknown> | undefined) ?? {};
    const spec: EntitySpec = entitySpec(id, options.module, {
      ...(kind !== undefined ? { kind } : {}),
      traits,
      fields,
      rules,
      metadata,
    });
    def.addInitialEntity(spec);
  }
}

function loadAssertions(def: GameDefinition, list: unknown[], options: LoadOptions): void {
  const path = options.source ?? "<input>";
  for (const node of list) {
    const obj = ensureMapping(node, `${path} (assertion)`);
    if (typeof obj["relation"] !== "string") {
      throw new YamlLoadError("assertion.relation must be a string", path);
    }
    const args = ensureArray(obj["args"] ?? [], `${path}.assertion.args`);
    def.addInitialAssertion({
      relation: obj["relation"],
      args,
      module: options.module,
    });
  }
}

function loadFacts(def: GameDefinition, list: unknown[], options: LoadOptions): void {
  const path = options.source ?? "<input>";
  for (const node of list) {
    const obj = ensureMapping(node, `${path} (fact)`);
    if (typeof obj["id"] !== "string") {
      throw new YamlLoadError("fact must have id", path);
    }
    const args = ensureArray(obj["args"] ?? [], `${path}.fact.args`);
    def.addInitialFact({ id: obj["id"], args, module: options.module });
  }
}

// ──────── Helpers ────────

function ensureArray(node: unknown, path: string): unknown[] {
  if (!Array.isArray(node)) {
    throw new YamlLoadError(`expected list, got ${typeof node}`, path);
  }
  return node;
}

function ensureMapping(node: unknown, path: string): Record<string, unknown> {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new YamlLoadError(`expected mapping, got ${Array.isArray(node) ? "array" : typeof node}`, path);
  }
  return node as Record<string, unknown>;
}

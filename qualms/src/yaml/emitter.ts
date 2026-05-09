/**
 * YAML emitter — inverse of `loader.ts`. Serializes a GameDefinition's slice
 * (single layer) back to a YAML string compatible with `loadYamlIntoDefinition`.
 *
 * Round-trip property: for any layer slice, `loadParsed(emitToObject(def, module))`
 * reproduces the original definitions, entities, assertions, and facts at that
 * layer. Exercised in `qualms/test/yaml.test.ts`.
 *
 * Predicate trees (rule guards, derived relation `get` bodies) are inverted to
 * the YAML predicate dialect via `emitPredicate`; effect lists are stored as
 * opaque records on the engine side and round-trip via `structuredClone`.
 */

import * as YAML from "js-yaml";
import type { GameDefinition } from "../core/definition.js";
import type {
  ActionDefinition,
  EffectSpec,
  EntitySpec,
  FieldDefinition,
  InitialAssertion,
  InitialFact,
  KindDefinition,
  Module,
  ParameterDefinition,
  RelationDefinition,
  Rule,
  RulebookDefinition,
  TraitAttachment,
  TraitDefinition,
} from "../core/types.js";
import type { Expression, Term } from "../query/ast.js";

export function emitDefinition(def: GameDefinition, module: Module): string {
  return YAML.dump(emitToObject(def, module), { schema: YAML.JSON_SCHEMA });
}

export function emitToObject(def: GameDefinition, module: Module): Record<string, unknown> {
  const definitions: Record<string, unknown> = {};
  const traits = def.traitsByModule(module).map(emitTrait);
  if (traits.length > 0) definitions["traits"] = traits;

  // Relations / actions / rules contributed by traits at this layer are
  // emitted nested inside their trait. Top-level entries are only those NOT
  // owned by a layer-local trait.
  const traitOwnedRelations = new Set<string>();
  const traitOwnedActions = new Set<string>();
  const traitOwnedRules = new Set<string>();
  for (const t of def.traitsByModule(module)) {
    for (const r of t.relations) traitOwnedRelations.add(r.id);
    for (const a of t.actions) traitOwnedActions.add(a.id);
    for (const rl of t.rules) traitOwnedRules.add(rl.id);
  }

  const relations = def
    .relationsByModule(module)
    .filter((r) => !traitOwnedRelations.has(r.id))
    .map(emitRelation);
  if (relations.length > 0) definitions["relations"] = relations;

  const actions = def
    .actionsByModule(module)
    .filter((a) => !traitOwnedActions.has(a.id))
    .map(emitAction);
  if (actions.length > 0) definitions["actions"] = actions;

  // Rules group by rulebook for emission.
  const moduleRules = def
    .rulesByModule(module)
    .filter((r) => !traitOwnedRules.has(r.id));
  const rulebooks = def.rulebooksByModule(module);
  const rulesByBook = new Map<string, Rule[]>();
  for (const rb of rulebooks) rulesByBook.set(rb.id, []);
  for (const r of moduleRules) {
    if (r.rulebook !== undefined) {
      const bucket = rulesByBook.get(r.rulebook) ?? [];
      bucket.push(r);
      rulesByBook.set(r.rulebook, bucket);
    }
  }
  const orphanRules = moduleRules.filter((r) => r.rulebook === undefined);
  if (rulebooks.length > 0) {
    definitions["rulebooks"] = rulebooks.map((rb) => ({
      id: rb.id,
      rules: (rulesByBook.get(rb.id) ?? []).map(emitRule),
    }));
  }
  if (orphanRules.length > 0) {
    // Orphan rules emitted as a synthetic anonymous rulebook for round-trip safety.
    const existing = (definitions["rulebooks"] as unknown[] | undefined) ?? [];
    definitions["rulebooks"] = [
      ...existing,
      { rules: orphanRules.map(emitRule) },
    ];
  }

  const kinds = def.kindsByModule(module).map(emitKind);
  if (kinds.length > 0) definitions["kinds"] = kinds;

  const out: Record<string, unknown> = {};
  if (Object.keys(definitions).length > 0) out["definitions"] = definitions;

  const entities = def.initialEntitiesByModule(module).map(emitEntity);
  if (entities.length > 0) out["entities"] = entities;

  const assertions = def.initialAssertionsByModule(module).map(emitAssertion);
  if (assertions.length > 0) out["assertions"] = assertions;

  const facts = def.initialFactsByModule(module).map(emitFact);
  if (facts.length > 0) out["facts"] = facts;

  // Module metadata (e.g. `start.*`).
  const md = def.metadataFor(module);
  const startKeys = Object.keys(md).filter((k) => k.startsWith("start."));
  if (startKeys.length > 0) {
    const start: Record<string, unknown> = {};
    for (const k of startKeys) start[k.slice("start.".length)] = md[k];
    out["start"] = start;
  }

  return out;
}

// ──────── Per-shape emitters ────────

function emitTrait(t: TraitDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = { id: t.id };
  if (t.parameters.length > 0) out["params"] = t.parameters.map(emitParameter);
  if (t.fields.length > 0) out["fields"] = t.fields.map(emitField);
  if (t.relations.length > 0) out["relations"] = t.relations.map(emitRelation);
  if (t.actions.length > 0) out["actions"] = t.actions.map(emitAction);
  if (t.rules.length > 0) out["rules"] = t.rules.map(emitRule);
  return out;
}

function emitRelation(r: RelationDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = { id: r.id };
  if (r.parameters.length > 0) out["params"] = r.parameters.map(emitParameter);
  if (r.get !== undefined) out["get"] = emitPredicate(r.get as Expression);
  if (r.setEffects !== undefined && r.setEffects.length > 0) {
    out["set"] = r.setEffects.map((e) => structuredClone(e) as unknown);
  }
  return out;
}

function emitAction(a: ActionDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = { id: a.id };
  if (a.parameters.length > 0) out["params"] = a.parameters.map(emitParameter);
  if (a.requires !== true && a.requires !== undefined) {
    out["requires"] = emitPredicate(a.requires as Expression);
  }
  if (a.defaultEffects.length > 0) {
    out["default"] = a.defaultEffects.map((e) => structuredClone(e) as unknown);
  }
  return out;
}

function emitRule(r: Rule): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: r.id,
    phase: r.phase,
    match: emitPattern(r.pattern),
  };
  if (r.guard !== true && r.guard !== undefined) {
    out["guard"] = emitPredicate(r.guard as Expression);
  }
  if (r.effects.length > 0) {
    out["effects"] = r.effects.map((e) => structuredClone(e) as unknown);
  }
  if (r.control !== "continue") out["control"] = r.control;
  if (r.priority !== 0) out["priority"] = r.priority;
  return out;
}

function emitPattern(p: Rule["pattern"]): Record<string, unknown> {
  const args = patternArgsToYaml(p.args);
  return {
    action: p.action,
    ...(Object.keys(args).length > 0 ? { args } : {}),
  };
}

function patternArgsToYaml(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  // Args in the pattern can be Term-shaped (from mutation parser) or already
  // primitives (from YAML loader). Term values: emit as `{var: name}` or scalar.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = isTermLike(v) ? emitTerm(v as Term) : (v as unknown);
  }
  return out;
}

function emitKind(k: KindDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: k.id,
    traits: k.traits.map(emitAttachment),
  };
  if (Object.keys(k.fields).length > 0) {
    out["fields"] = structuredClone(k.fields);
  }
  if (k.rules.length > 0) out["rules"] = k.rules.map(emitRule);
  return out;
}

function emitAttachment(a: TraitAttachment): unknown {
  if (Object.keys(a.parameters).length === 0 && Object.keys(a.fields).length === 0) {
    return a.id;
  }
  const out: Record<string, unknown> = { id: a.id };
  if (Object.keys(a.parameters).length > 0) out["params"] = structuredClone(a.parameters);
  if (Object.keys(a.fields).length > 0) out["fields"] = structuredClone(a.fields);
  return out;
}

function emitEntity(e: EntitySpec): Record<string, unknown> {
  const out: Record<string, unknown> = { id: e.id };
  if (e.kind !== undefined) out["kind"] = e.kind;
  if (e.traits.length > 0) out["traits"] = e.traits.map(emitAttachment);
  if (Object.keys(e.fields).length > 0) out["fields"] = structuredClone(e.fields);
  if (e.rules.length > 0) out["rules"] = e.rules.map(emitRule);
  if (Object.keys(e.metadata).length > 0) out["metadata"] = structuredClone(e.metadata);
  return out;
}

function emitAssertion(a: InitialAssertion): Record<string, unknown> {
  return { relation: a.relation, args: [...a.args] };
}

function emitFact(f: InitialFact): Record<string, unknown> {
  return { id: f.id, args: [...f.args] };
}

function emitParameter(p: ParameterDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = { id: p.id };
  if (p.type !== "value") out["type"] = p.type;
  if (p.hasDefault) out["default"] = p.default;
  return out;
}

function emitField(f: FieldDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = { id: f.id };
  if (f.type !== "value") out["type"] = f.type;
  if (f.hasDefault) out["default"] = f.default;
  return out;
}

// ──────── Predicate / Term inverters ────────

/**
 * Inverse of `loader/predicate.ts`. Maps the Expression AST back to the YAML
 * predicate dialect used by the loader. Keeps the YAML schema stable so that
 * round-trips remain lossless for the predicate node types the loader knows.
 */
export function emitPredicate(expr: Expression): unknown {
  switch (expr.type) {
    case "literal":
      return expr.value;
    case "and":
      return { all: collectAnd(expr).map(emitPredicate) };
    case "or":
      return { any: collectOr(expr).map(emitPredicate) };
    case "not":
      return { not: emitPredicate(expr.operand) };
    case "equal":
      return { eq: [emitTerm(expr.left), emitTerm(expr.right)] };
    case "notEqual":
      return { not: { eq: [emitTerm(expr.left), emitTerm(expr.right)] } };
    case "relation":
      return {
        relation: { id: expr.relation, args: expr.args.map(emitTerm) },
      };
    case "traitOf":
      return {
        has_trait: {
          entity: emitTerm(expr.entity),
          trait: expr.filter.name,
          ...(expr.filter.module !== undefined ? { layer: expr.filter.module } : {}),
        },
      };
    case "exists":
      return {
        exists: {
          variable: expr.variable,
          ...(expr.traitFilter !== undefined ? { trait: expr.traitFilter.name } : {}),
          body: emitPredicate(expr.body),
        },
      };
    case "forall":
      return {
        forall: {
          variable: expr.variable,
          ...(expr.traitFilter !== undefined ? { trait: expr.traitFilter.name } : {}),
          body: emitPredicate(expr.body),
        },
      };
    case "regex":
      return {
        regex: {
          subject: emitTerm(expr.subject),
          pattern: expr.pattern,
          ...(expr.flags !== undefined ? { flags: expr.flags } : {}),
        },
      };
    case "like":
      return {
        like: { subject: emitTerm(expr.subject), pattern: expr.pattern },
      };
    case "path":
      return {
        path: {
          from: emitTerm(expr.from),
          to: emitTerm(expr.to),
          relations: [...expr.relations],
          direction: expr.direction,
          quantifier: expr.quantifier,
        },
      };
  }
}

function collectAnd(expr: Expression): Expression[] {
  if (expr.type === "and") return [...collectAnd(expr.left), ...collectAnd(expr.right)];
  return [expr];
}

function collectOr(expr: Expression): Expression[] {
  if (expr.type === "or") return [...collectOr(expr.left), ...collectOr(expr.right)];
  return [expr];
}

export function emitTerm(term: Term): unknown {
  switch (term.type) {
    case "value":
      return term.value;
    case "var":
      return { var: term.name };
    case "field":
      return {
        field: {
          entity: emitTerm(term.entity),
          ...(term.trait !== undefined ? { trait: term.trait } : {}),
          field: term.field,
        },
      };
  }
}

function isTermLike(v: unknown): v is Term {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: string }).type;
  return t === "var" || t === "value" || t === "field";
}

// Re-export effect type for convenience to consumers that emit ad-hoc YAML.
export type { EffectSpec };

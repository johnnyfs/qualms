/**
 * Meta-layer enumeration and introspection — the bridge that lets the query
 * evaluator address structural objects (Trait, Kind, Action, Relation, Rule)
 * in the same namespace as world entities.
 *
 * A "meta-entity" is identified by a string id (the trait/kind/etc. id). Field
 * access on meta-entities resolves to virtual fields synthesized here:
 *   - all meta-entities expose `id` and `layer`.
 *   - Relation also exposes `persistence`.
 *   - Rule also exposes `phase`.
 *
 * Introspection relations:
 *   - uses(kind, trait)            kind has trait as an attachment
 *   - instance_of(entity, kind)    entity built from this kind
 *   - defines(trait, name)         trait declares a field/relation/action/rule with this id
 *   - in_layer(id, module)          structural object or entity is from this layer
 */

import type { GameDefinition } from "../core/definition.js";
import type { Module } from "../core/types.js";
import type { WorldState } from "../core/worldState.js";
import type { MetaType } from "./ast.js";

export interface MetaContext {
  definition: GameDefinition;
  state?: WorldState; // optional — meta queries that touch live entities require it
}

/** Enumerate ids belonging to a meta-type, optionally filtered by layer. */
export function enumerateMetaIds(
  ctx: MetaContext,
  metaType: MetaType,
  module?: Module,
): string[] {
  switch (metaType) {
    case "Trait":
      return [...ctx.definition.traits.values()]
        .filter((t) => module === undefined || t.module === module)
        .map((t) => t.id);
    case "Kind":
      return [...ctx.definition.kinds.values()]
        .filter((k) => module === undefined || k.module === module)
        .map((k) => k.id);
    case "Action":
      return [...ctx.definition.actions.values()]
        .filter((a) => module === undefined || a.module === module)
        .map((a) => a.id);
    case "Relation":
      return [...ctx.definition.relations.values()]
        .filter((r) => module === undefined || r.module === module)
        .map((r) => r.id);
    case "Rule":
      return ctx.definition.rules
        .filter((r) => module === undefined || r.module === module)
        .map((r) => r.id);
    case "Entity": {
      if (!ctx.state) return [];
      return [...ctx.state.entities.values()]
        .filter((e) => module === undefined || e.module === module)
        .map((e) => e.id);
    }
  }
}

/** Get the layer of a structural object / entity by id, or null if unknown. */
export function moduleOfId(ctx: MetaContext, id: string): Module | null {
  if (ctx.definition.hasTrait(id)) return ctx.definition.trait(id).module;
  if (ctx.definition.hasKind(id)) return ctx.definition.kind(id).module;
  if (ctx.definition.hasAction(id)) return ctx.definition.action(id).module;
  if (ctx.definition.hasRelation(id)) return ctx.definition.relation(id).module;
  const rule = ctx.definition.rules.find((r) => r.id === id);
  if (rule) return rule.module;
  if (ctx.state?.entities.has(id)) return ctx.state.entities.get(id)!.module;
  return null;
}

/** Resolve a virtual field on a meta-entity (or world entity). Throws on unknown. */
export function metaFieldValue(ctx: MetaContext, id: string, field: string): unknown {
  // Meta-entities first.
  if (ctx.definition.hasTrait(id)) {
    const t = ctx.definition.trait(id);
    if (field === "id") return t.id;
    if (field === "layer") return t.module;
    throw new Error(`unknown virtual field 'Trait.${field}' on '${id}'`);
  }
  if (ctx.definition.hasKind(id)) {
    const k = ctx.definition.kind(id);
    if (field === "id") return k.id;
    if (field === "layer") return k.module;
    throw new Error(`unknown virtual field 'Kind.${field}' on '${id}'`);
  }
  if (ctx.definition.hasAction(id)) {
    const a = ctx.definition.action(id);
    if (field === "id") return a.id;
    if (field === "layer") return a.module;
    throw new Error(`unknown virtual field 'Action.${field}' on '${id}'`);
  }
  if (ctx.definition.hasRelation(id)) {
    const r = ctx.definition.relation(id);
    if (field === "id") return r.id;
    if (field === "layer") return r.module;
    if (field === "derived") return r.get !== undefined;
    throw new Error(`unknown virtual field 'Relation.${field}' on '${id}'`);
  }
  const rule = ctx.definition.rules.find((r) => r.id === id);
  if (rule) {
    if (field === "id") return rule.id;
    if (field === "layer") return rule.module;
    if (field === "phase") return rule.phase;
    throw new Error(`unknown virtual field 'Rule.${field}' on '${id}'`);
  }
  if (ctx.state?.entities.has(id)) {
    const e = ctx.state.entities.get(id)!;
    if (field === "id") return e.id;
    if (field === "layer") return e.module;
    throw new Error(`unknown virtual field 'Entity.${field}' on '${id}' (use trait-qualified access for trait fields)`);
  }
  throw new Error(`cannot resolve field '${field}' on '${id}': not a known meta-entity or entity`);
}

/** Enumerate `uses(kind, trait)` tuples. */
export function enumerateUses(ctx: MetaContext): { kind: string; trait: string }[] {
  const out: { kind: string; trait: string }[] = [];
  for (const k of ctx.definition.kinds.values()) {
    for (const att of k.traits) {
      out.push({ kind: k.id, trait: att.id });
    }
  }
  return out;
}

/** Enumerate `instance_of(entity, kind)` tuples. */
export function enumerateInstanceOf(ctx: MetaContext): { entity: string; kind: string }[] {
  if (!ctx.state) return [];
  const out: { entity: string; kind: string }[] = [];
  for (const e of ctx.state.entities.values()) {
    const kindId = e.metadata["kind"];
    if (typeof kindId === "string") out.push({ entity: e.id, kind: kindId });
  }
  return out;
}

/**
 * Enumerate `defines(trait, name)` tuples — each trait declares 0+ fields,
 * relations, actions, rules. We enumerate all of them.
 */
export function enumerateDefines(ctx: MetaContext): { trait: string; name: string }[] {
  const out: { trait: string; name: string }[] = [];
  for (const t of ctx.definition.traits.values()) {
    for (const fld of t.fields) out.push({ trait: t.id, name: fld.id });
    for (const r of t.relations) out.push({ trait: t.id, name: r.id });
    for (const a of t.actions) out.push({ trait: t.id, name: a.id });
    for (const rl of t.rules) out.push({ trait: t.id, name: rl.id });
  }
  return out;
}

/** Enumerate `in_layer(id, module)` tuples for every known structural object and entity. */
export function enumerateInLayer(ctx: MetaContext): { id: string; module: Module }[] {
  const out: { id: string; module: Module }[] = [];
  for (const t of ctx.definition.traits.values()) out.push({ id: t.id, module: t.module });
  for (const k of ctx.definition.kinds.values()) out.push({ id: k.id, module: k.module });
  for (const a of ctx.definition.actions.values()) out.push({ id: a.id, module: a.module });
  for (const r of ctx.definition.relations.values()) out.push({ id: r.id, module: r.module });
  for (const rl of ctx.definition.rules) out.push({ id: rl.id, module: rl.module });
  if (ctx.state) {
    for (const e of ctx.state.entities.values()) out.push({ id: e.id, module: e.module });
  }
  return out;
}

/**
 * WorldState — the live runtime state. Entities, trait fields, the unified
 * stored-relations Map, legacy facts, events, and allocators all live here.
 *
 * Relations are either stored (no `get` body on the RelationDefinition) or
 * derived (have a `get`). `test()` consults the predicate evaluator when called
 * on a derived relation; until that path is wired through this module, derived
 * relations throw from `test()`. Stored relations live in a single
 * `relations` Map keyed by `relationKey(relationId, args)`.
 */

import { GameDefinition } from "./definition.js";
import type {
  ActionAttempt,
  ActionResult,
  Entity,
  EntitySpec,
  Module,
  TraitAttachment,
  TraitInstance,
} from "./types.js";

/** Serialized relation key: relationId + JSON-stable args. */
function relationKey(relationId: string, args: readonly unknown[]): string {
  return `${relationId}|${JSON.stringify(args)}`;
}

function factKey(id: string, args: readonly unknown[]): string {
  return `${id}|${JSON.stringify(args)}`;
}

export class WorldState {
  readonly definition: GameDefinition;
  readonly entities: Map<string, Entity> = new Map();
  /** Unified stored-relations Map (post-persistence-collapse). Tagged by source layer. */
  private readonly relations: Map<string, Module | "runtime"> = new Map();
  /** Legacy untyped facts. */
  private readonly facts: Map<string, Module | "runtime"> = new Map();
  readonly events: Record<string, unknown>[] = [];
  readonly allocators: Map<string, number> = new Map();

  constructor(definition: GameDefinition) {
    this.definition = definition;
  }

  // ──────── Entities ────────

  entity(id: string): Entity {
    const e = this.entities.get(id);
    if (!e) throw new Error(`unknown entity '${id}'`);
    return e;
  }

  hasEntity(id: string): boolean {
    return this.entities.has(id);
  }

  hasTrait(entityId: string, traitId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.entity(entityId).traits, traitId);
  }

  getField(entityId: string, traitId: string, fieldId: string): unknown {
    const t = this.entity(entityId).traits[traitId];
    if (!t) throw new Error(`entity '${entityId}' lacks trait '${traitId}'`);
    return t.fields[fieldId];
  }

  setField(entityId: string, traitId: string, fieldId: string, value: unknown): void {
    const t = this.entity(entityId).traits[traitId];
    if (!t) throw new Error(`entity '${entityId}' lacks trait '${traitId}'`);
    // Validate the field exists on the trait definition.
    const traitDef = this.definition.trait(traitId);
    if (!traitDef.fields.some((f) => f.id === fieldId)) {
      throw new Error(`trait '${traitId}' has no field '${fieldId}'`);
    }
    t.fields[fieldId] = value;
  }

  grantTrait(entityId: string, attachment: TraitAttachment): void {
    const e = this.entity(entityId);
    e.traits[attachment.id] = buildTraitInstance(this.definition, attachment);
  }

  revokeTrait(entityId: string, traitId: string): void {
    delete this.entity(entityId).traits[traitId];
  }

  // ──────── Relations ────────

  /**
   * Tests a stored relation. Throws on derived relations (those with a `get`
   * body) — derived evaluation goes through the query evaluator, not `test()`.
   */
  test(relationId: string, args: readonly unknown[]): boolean {
    const rel = this.definition.relation(relationId);
    if (rel.get !== undefined) {
      throw new Error(
        `relation '${relationId}' is derived; evaluate via runQuery, not state.test()`,
      );
    }
    return this.relations.has(relationKey(relationId, args));
  }

  assertRelation(
    relationId: string,
    args: readonly unknown[],
    sourceModule: Module | "runtime" = "runtime",
  ): void {
    const rel = this.definition.relation(relationId);
    if (rel.get !== undefined) {
      throw new Error(
        `relation '${relationId}' is derived; cannot assert directly`,
      );
    }
    this.relations.set(relationKey(relationId, args), sourceModule);
  }

  retractRelation(relationId: string, args: readonly unknown[]): void {
    const rel = this.definition.relation(relationId);
    if (rel.get !== undefined) {
      throw new Error(`relation '${relationId}' is derived; cannot retract`);
    }
    this.relations.delete(relationKey(relationId, args));
  }

  /** Enumerate stored relations matching a relation id. Returns serialized arg arrays. */
  storedTuples(relationId: string): { args: unknown[]; module: Module | "runtime" }[] {
    const rel = this.definition.relation(relationId);
    if (rel.get !== undefined) return [];
    const prefix = `${relationId}|`;
    const out: { args: unknown[]; module: Module | "runtime" }[] = [];
    for (const [key, module] of this.relations.entries()) {
      if (!key.startsWith(prefix)) continue;
      const argsJson = key.slice(prefix.length);
      out.push({ args: JSON.parse(argsJson) as unknown[], module });
    }
    return out;
  }

  // ──────── Facts (legacy untyped memory) ────────

  hasFact(id: string, args: readonly unknown[] = []): boolean {
    return this.facts.has(factKey(id, args));
  }

  setFact(id: string, args: readonly unknown[] = [], sourceModule: Module | "runtime" = "runtime"): void {
    this.facts.set(factKey(id, args), sourceModule);
  }

  clearFact(id: string, args: readonly unknown[] = []): void {
    this.facts.delete(factKey(id, args));
  }

  // ──────── Allocators ────────

  allocate(prefix: string): string {
    const next = (this.allocators.get(prefix) ?? 1);
    this.allocators.set(prefix, next + 1);
    return `${prefix}-${next}`;
  }

  // ──────── Snapshot / clone (for transactional rollback) ────────

  /**
   * Deep-clone the WorldState for transaction snapshots. The caller must pass
   * the corresponding cloned `GameDefinition` so the copy holds a consistent ref.
   *
   * NOTE: this is a provisional implementation for the mutation-tools
   * milestone. Cloning scales with world size, not transaction size, and
   * forecloses parallel transactions across scopes. The intended endpoint is a
   * functional amend layer (base ref + delta merged on read). Replace this
   * `clone()` and the matching `GameDefinition.clone()` together when that lands.
   */
  clone(definition: GameDefinition): WorldState {
    const out = new WorldState(definition);
    for (const [id, e] of this.entities) {
      out.entities.set(id, structuredClone(e));
    }
    for (const [k, v] of this.relations) out.relations.set(k, v);
    for (const [k, v] of this.facts) out.facts.set(k, v);
    out.events.push(...this.events.map((e) => structuredClone(e)));
    for (const [k, v] of this.allocators) out.allocators.set(k, v);
    return out;
  }

}

/**
 * Resolve a field target on an entity to (traitId, fieldId). Used by both the
 * query evaluator (for field-access reads) and the mutation executor (for `:=`
 * writes). Validates: entity exists, trait is on the entity, field exists on
 * the trait. Throws on ambiguity (multiple traits define the same field id).
 *
 * Returns `null` if the entity doesn't exist (caller can fall back to meta-field
 * resolution against structural objects).
 */
export function resolveFieldTarget(
  state: WorldState,
  entityId: string,
  fieldId: string,
  traitId?: string,
): { traitId: string; fieldId: string } | null {
  if (!state.hasEntity(entityId)) return null;
  if (traitId !== undefined) {
    const def = state.definition;
    if (!def.hasTrait(traitId)) {
      throw new Error(`unknown trait '${traitId}' on entity '${entityId}'`);
    }
    if (!def.trait(traitId).fields.some((f) => f.id === fieldId)) {
      throw new Error(`trait '${traitId}' has no field '${fieldId}'`);
    }
    return { traitId, fieldId };
  }
  const entity = state.entity(entityId);
  const matches: string[] = [];
  for (const tId of Object.keys(entity.traits)) {
    const traitDef = state.definition.trait(tId);
    if (traitDef.fields.some((f) => f.id === fieldId)) matches.push(tId);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `ambiguous field '${fieldId}' on '${entityId}': defined by traits ${matches.join(", ")} — qualify with .Trait.${fieldId}`,
    );
  }
  return { traitId: matches[0]!, fieldId };
}

// ──────── Builders ────────

export function buildTraitInstance(
  definition: GameDefinition,
  attachment: TraitAttachment,
): TraitInstance {
  const traitDef = definition.trait(attachment.id);
  const fields: Record<string, unknown> = {};
  for (const f of traitDef.fields) {
    if (f.hasDefault) fields[f.id] = structuredClone(f.default);
  }
  for (const [k, v] of Object.entries(attachment.fields)) {
    fields[k] = structuredClone(v);
  }
  return {
    definitionId: attachment.id,
    parameters: { ...attachment.parameters },
    fields,
  };
}

export function buildEntity(definition: GameDefinition, spec: EntitySpec): Entity {
  const traitAttachments: Map<string, TraitAttachment> = new Map();
  const fieldOverrides: Map<string, Record<string, unknown>> = new Map();

  if (spec.kind) {
    const kindDef = definition.kind(spec.kind);
    for (const att of kindDef.traits) {
      traitAttachments.set(att.id, att);
    }
    for (const [traitId, fields] of Object.entries(kindDef.fields)) {
      fieldOverrides.set(traitId, { ...(fieldOverrides.get(traitId) ?? {}), ...fields });
    }
  }
  for (const att of spec.traits) {
    const previous = traitAttachments.get(att.id);
    traitAttachments.set(
      att.id,
      previous
        ? {
            id: att.id,
            parameters: { ...previous.parameters, ...att.parameters },
            fields: { ...previous.fields, ...att.fields },
          }
        : att,
    );
  }
  for (const [traitId, fields] of Object.entries(spec.fields)) {
    fieldOverrides.set(traitId, { ...(fieldOverrides.get(traitId) ?? {}), ...fields });
  }

  const entity: Entity = {
    id: spec.id,
    module: spec.module,
    traits: {},
    metadata: { ...spec.metadata },
  };
  if (spec.kind) {
    if (entity.metadata["kind"] === undefined) entity.metadata["kind"] = spec.kind;
  }
  for (const [traitId, attachment] of traitAttachments) {
    const override = fieldOverrides.get(traitId) ?? {};
    const merged: TraitAttachment = {
      id: attachment.id,
      parameters: attachment.parameters,
      fields: { ...attachment.fields, ...override },
    };
    entity.traits[traitId] = buildTraitInstance(definition, merged);
  }
  return entity;
}

export function instantiate(definition: GameDefinition): WorldState {
  definition.validate();
  const state = new WorldState(definition);
  for (const spec of definition.initialEntities) {
    if (state.entities.has(spec.id)) {
      throw new Error(`duplicate entity '${spec.id}'`);
    }
    state.entities.set(spec.id, buildEntity(definition, spec));
  }
  for (const fact of definition.initialFacts) {
    state.setFact(fact.id, fact.args, fact.module);
  }
  for (const assertion of definition.initialAssertions) {
    state.assertRelation(assertion.relation, assertion.args, assertion.module);
  }
  return state;
}

// ──────── Action engine (stub for step 1) ────────

export class RulesEngine {
  readonly definition: GameDefinition;

  constructor(definition: GameDefinition) {
    this.definition = definition;
  }

  /**
   * Stub: action attempt returns `unimplemented` in step 1. The real engine
   * arrives once the predicate/effect AST and evaluator are in place (step 2+).
   */
  attempt(_state: WorldState, attempt: ActionAttempt): ActionResult {
    // Validate the action is known so callers get a useful error if they
    // mistype an action id even before evaluation lands.
    this.definition.action(attempt.actionId);
    return { status: "unimplemented", events: [] };
  }
}

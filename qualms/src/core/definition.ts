/**
 * GameDefinition — the merged, layer-aware container for traits, relations,
 * actions, rules, kinds, and initial state across the prelude/game/session
 * layers.
 *
 * Each contained definition tracks the layer it came from. Lookups can return
 * the merged view (default) or a layer-filtered view via `*ByLayer`.
 *
 * Trait-contributed relations / actions / rules are lifted into the top-level
 * maps on add, matching the Python engine's `_include_contributed_definitions`
 * behaviour but applied incrementally as traits are registered.
 */

import type {
  ActionDefinition,
  EntitySpec,
  InitialAssertion,
  InitialFact,
  KindDefinition,
  Layer,
  RelationDefinition,
  Rule,
  TraitDefinition,
} from "./types.js";

export class DuplicateDefinitionError extends Error {
  constructor(kind: string, id: string, existingLayer: Layer, incomingLayer: Layer) {
    super(
      `duplicate ${kind} '${id}' (existing layer=${existingLayer}, incoming layer=${incomingLayer})`,
    );
    this.name = "DuplicateDefinitionError";
  }
}

export class UnknownDefinitionError extends Error {
  constructor(kind: string, id: string) {
    super(`unknown ${kind} '${id}'`);
    this.name = "UnknownDefinitionError";
  }
}

export class GameDefinition {
  private readonly _traits: Map<string, TraitDefinition> = new Map();
  private readonly _relations: Map<string, RelationDefinition> = new Map();
  private readonly _actions: Map<string, ActionDefinition> = new Map();
  private readonly _kinds: Map<string, KindDefinition> = new Map();
  private readonly _rules: Rule[] = [];
  private readonly _initialEntities: EntitySpec[] = [];
  private readonly _initialAssertions: InitialAssertion[] = [];
  private readonly _initialFacts: InitialFact[] = [];
  private readonly _metadata: Record<Layer, Record<string, unknown>> = {
    prelude: {},
    game: {},
    session: {},
  };

  // ──────── Adders ────────

  addTrait(definition: TraitDefinition): void {
    const existing = this._traits.get(definition.id);
    if (existing) {
      throw new DuplicateDefinitionError("trait", definition.id, existing.layer, definition.layer);
    }
    this._traits.set(definition.id, definition);
    // Lift trait-owned relations / actions / rules into the merged tables.
    for (const r of definition.relations) {
      this.addRelation(r);
    }
    for (const a of definition.actions) {
      this.addAction(a);
    }
    for (const rl of definition.rules) {
      this.addRule(rl);
    }
  }

  addRelation(definition: RelationDefinition): void {
    const existing = this._relations.get(definition.id);
    if (existing) {
      throw new DuplicateDefinitionError(
        "relation",
        definition.id,
        existing.layer,
        definition.layer,
      );
    }
    this._relations.set(definition.id, definition);
  }

  addAction(definition: ActionDefinition): void {
    const existing = this._actions.get(definition.id);
    if (existing) {
      throw new DuplicateDefinitionError(
        "action",
        definition.id,
        existing.layer,
        definition.layer,
      );
    }
    this._actions.set(definition.id, definition);
  }

  addKind(definition: KindDefinition): void {
    const existing = this._kinds.get(definition.id);
    if (existing) {
      throw new DuplicateDefinitionError("kind", definition.id, existing.layer, definition.layer);
    }
    this._kinds.set(definition.id, definition);
  }

  addRule(rule: Rule): void {
    if (this._rules.some((r) => r.id === rule.id)) {
      // Trait-lift duplicates are quietly skipped on the Python side; we replicate.
      return;
    }
    this._rules.push(rule);
  }

  addInitialEntity(spec: EntitySpec): void {
    if (this._initialEntities.some((e) => e.id === spec.id)) {
      throw new DuplicateDefinitionError(
        "initial entity",
        spec.id,
        this._initialEntities.find((e) => e.id === spec.id)!.layer,
        spec.layer,
      );
    }
    this._initialEntities.push(spec);
  }

  addInitialAssertion(assertion: InitialAssertion): void {
    this._initialAssertions.push(assertion);
  }

  addInitialFact(fact: InitialFact): void {
    this._initialFacts.push(fact);
  }

  setMetadata(layer: Layer, key: string, value: unknown): void {
    this._metadata[layer][key] = value;
  }

  // ──────── Lookups (merged) ────────

  trait(id: string): TraitDefinition {
    const t = this._traits.get(id);
    if (!t) throw new UnknownDefinitionError("trait", id);
    return t;
  }

  relation(id: string): RelationDefinition {
    const r = this._relations.get(id);
    if (!r) throw new UnknownDefinitionError("relation", id);
    return r;
  }

  action(id: string): ActionDefinition {
    const a = this._actions.get(id);
    if (!a) throw new UnknownDefinitionError("action", id);
    return a;
  }

  kind(id: string): KindDefinition {
    const k = this._kinds.get(id);
    if (!k) throw new UnknownDefinitionError("kind", id);
    return k;
  }

  hasTrait(id: string): boolean {
    return this._traits.has(id);
  }
  hasRelation(id: string): boolean {
    return this._relations.has(id);
  }
  hasAction(id: string): boolean {
    return this._actions.has(id);
  }
  hasKind(id: string): boolean {
    return this._kinds.has(id);
  }

  get traits(): ReadonlyMap<string, TraitDefinition> {
    return this._traits;
  }
  get relations(): ReadonlyMap<string, RelationDefinition> {
    return this._relations;
  }
  get actions(): ReadonlyMap<string, ActionDefinition> {
    return this._actions;
  }
  get kinds(): ReadonlyMap<string, KindDefinition> {
    return this._kinds;
  }
  get rules(): readonly Rule[] {
    return this._rules;
  }
  get initialEntities(): readonly EntitySpec[] {
    return this._initialEntities;
  }
  get initialAssertions(): readonly InitialAssertion[] {
    return this._initialAssertions;
  }
  get initialFacts(): readonly InitialFact[] {
    return this._initialFacts;
  }
  metadataFor(layer: Layer): Readonly<Record<string, unknown>> {
    return this._metadata[layer];
  }

  // ──────── Layer-filtered views ────────

  traitsByLayer(layer: Layer): TraitDefinition[] {
    return [...this._traits.values()].filter((t) => t.layer === layer);
  }
  relationsByLayer(layer: Layer): RelationDefinition[] {
    return [...this._relations.values()].filter((r) => r.layer === layer);
  }
  actionsByLayer(layer: Layer): ActionDefinition[] {
    return [...this._actions.values()].filter((a) => a.layer === layer);
  }
  kindsByLayer(layer: Layer): KindDefinition[] {
    return [...this._kinds.values()].filter((k) => k.layer === layer);
  }
  rulesByLayer(layer: Layer): Rule[] {
    return this._rules.filter((r) => r.layer === layer);
  }
  initialEntitiesByLayer(layer: Layer): EntitySpec[] {
    return this._initialEntities.filter((e) => e.layer === layer);
  }
  initialAssertionsByLayer(layer: Layer): InitialAssertion[] {
    return this._initialAssertions.filter((a) => a.layer === layer);
  }
  initialFactsByLayer(layer: Layer): InitialFact[] {
    return this._initialFacts.filter((f) => f.layer === layer);
  }

  // ──────── Validation ────────

  /**
   * Walk every relation/action/kind/entity-spec and confirm that it references
   * only known traits and (for relation persistence) known relations.
   *
   * Throws on the first error. Used by the loader and by tests.
   */
  validate(): void {
    for (const k of this._kinds.values()) {
      for (const att of k.traits) {
        if (!this._traits.has(att.id)) {
          throw new Error(`kind '${k.id}' references unknown trait '${att.id}'`);
        }
      }
    }
    for (const e of this._initialEntities) {
      if (e.kind !== undefined && !this._kinds.has(e.kind)) {
        throw new Error(`entity '${e.id}' references unknown kind '${e.kind}'`);
      }
      for (const att of e.traits) {
        if (!this._traits.has(att.id)) {
          throw new Error(`entity '${e.id}' references unknown trait '${att.id}'`);
        }
      }
    }
    for (const a of this._initialAssertions) {
      if (!this._relations.has(a.relation)) {
        throw new Error(`initial assertion references unknown relation '${a.relation}'`);
      }
    }
  }
}

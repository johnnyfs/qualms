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
  Module,
  RelationDefinition,
  Rule,
  RulebookDefinition,
  TraitDefinition,
} from "./types.js";

export class DuplicateDefinitionError extends Error {
  constructor(kind: string, id: string, existingModule: Module, incomingModule: Module) {
    super(
      `duplicate ${kind} '${id}' (existing layer=${existingModule}, incoming layer=${incomingModule})`,
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
  private _traits: Map<string, TraitDefinition> = new Map();
  private _relations: Map<string, RelationDefinition> = new Map();
  private _actions: Map<string, ActionDefinition> = new Map();
  private _kinds: Map<string, KindDefinition> = new Map();
  private _rulebooks: Map<string, RulebookDefinition> = new Map();
  private _rules: Rule[] = [];
  private _initialEntities: EntitySpec[] = [];
  private _initialAssertions: InitialAssertion[] = [];
  private _initialFacts: InitialFact[] = [];
  private _metadata: Record<Module, Record<string, unknown>> = {
    prelude: {},
    game: {},
    session: {},
  };

  // ──────── Adders ────────

  addTrait(definition: TraitDefinition): void {
    const existing = this._traits.get(definition.id);
    if (existing) {
      throw new DuplicateDefinitionError("trait", definition.id, existing.module, definition.module);
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
        existing.module,
        definition.module,
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
        existing.module,
        definition.module,
      );
    }
    this._actions.set(definition.id, definition);
  }

  addKind(definition: KindDefinition): void {
    const existing = this._kinds.get(definition.id);
    if (existing) {
      throw new DuplicateDefinitionError("kind", definition.id, existing.module, definition.module);
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

  addRulebook(definition: RulebookDefinition): void {
    const existing = this._rulebooks.get(definition.id);
    if (existing) {
      throw new DuplicateDefinitionError(
        "rulebook",
        definition.id,
        existing.module,
        definition.module,
      );
    }
    this._rulebooks.set(definition.id, definition);
  }

  addInitialEntity(spec: EntitySpec): void {
    if (this._initialEntities.some((e) => e.id === spec.id)) {
      throw new DuplicateDefinitionError(
        "initial entity",
        spec.id,
        this._initialEntities.find((e) => e.id === spec.id)!.module,
        spec.module,
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

  setMetadata(module: Module, key: string, value: unknown): void {
    this._metadata[module][key] = value;
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

  rulebook(id: string): RulebookDefinition {
    const rb = this._rulebooks.get(id);
    if (!rb) throw new UnknownDefinitionError("rulebook", id);
    return rb;
  }

  rule(id: string): Rule {
    const r = this._rules.find((r) => r.id === id);
    if (!r) throw new UnknownDefinitionError("rule", id);
    return r;
  }

  initialEntity(id: string): EntitySpec {
    const e = this._initialEntities.find((e) => e.id === id);
    if (!e) throw new UnknownDefinitionError("initial entity", id);
    return e;
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
  hasRulebook(id: string): boolean {
    return this._rulebooks.has(id);
  }
  hasRule(id: string): boolean {
    return this._rules.some((r) => r.id === id);
  }
  hasInitialEntity(id: string): boolean {
    return this._initialEntities.some((e) => e.id === id);
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
  get rulebooks(): ReadonlyMap<string, RulebookDefinition> {
    return this._rulebooks;
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
  metadataFor(module: Module): Readonly<Record<string, unknown>> {
    return this._metadata[module];
  }

  // ──────── Module-filtered views ────────

  traitsByModule(module: Module): TraitDefinition[] {
    return [...this._traits.values()].filter((t) => t.module === module);
  }
  relationsByModule(module: Module): RelationDefinition[] {
    return [...this._relations.values()].filter((r) => r.module === module);
  }
  actionsByModule(module: Module): ActionDefinition[] {
    return [...this._actions.values()].filter((a) => a.module === module);
  }
  kindsByModule(module: Module): KindDefinition[] {
    return [...this._kinds.values()].filter((k) => k.module === module);
  }
  rulebooksByModule(module: Module): RulebookDefinition[] {
    return [...this._rulebooks.values()].filter((rb) => rb.module === module);
  }
  rulesByModule(module: Module): Rule[] {
    return this._rules.filter((r) => r.module === module);
  }
  initialEntitiesByModule(module: Module): EntitySpec[] {
    return this._initialEntities.filter((e) => e.module === module);
  }
  initialAssertionsByModule(module: Module): InitialAssertion[] {
    return this._initialAssertions.filter((a) => a.module === module);
  }
  initialFactsByModule(module: Module): InitialFact[] {
    return this._initialFacts.filter((f) => f.module === module);
  }

  // ──────── Removers (for `undef` mutations) ────────

  removeTrait(id: string): TraitDefinition {
    const t = this._traits.get(id);
    if (!t) throw new UnknownDefinitionError("trait", id);
    this._traits.delete(id);
    // Lifted relations/actions/rules came in via addTrait — drop them too.
    for (const r of t.relations) this._relations.delete(r.id);
    for (const a of t.actions) this._actions.delete(a.id);
    for (const rl of t.rules) {
      const idx = this._rules.findIndex((x) => x.id === rl.id);
      if (idx >= 0) this._rules.splice(idx, 1);
    }
    return t;
  }

  removeRelation(id: string): RelationDefinition {
    const r = this._relations.get(id);
    if (!r) throw new UnknownDefinitionError("relation", id);
    this._relations.delete(id);
    return r;
  }

  removeAction(id: string): ActionDefinition {
    const a = this._actions.get(id);
    if (!a) throw new UnknownDefinitionError("action", id);
    this._actions.delete(id);
    return a;
  }

  removeKind(id: string): KindDefinition {
    const k = this._kinds.get(id);
    if (!k) throw new UnknownDefinitionError("kind", id);
    this._kinds.delete(id);
    return k;
  }

  removeRulebook(id: string): RulebookDefinition {
    const rb = this._rulebooks.get(id);
    if (!rb) throw new UnknownDefinitionError("rulebook", id);
    this._rulebooks.delete(id);
    return rb;
  }

  removeRule(id: string): Rule {
    const idx = this._rules.findIndex((r) => r.id === id);
    if (idx < 0) throw new UnknownDefinitionError("rule", id);
    return this._rules.splice(idx, 1)[0]!;
  }

  removeInitialEntity(id: string): EntitySpec {
    const idx = this._initialEntities.findIndex((e) => e.id === id);
    if (idx < 0) throw new UnknownDefinitionError("initial entity", id);
    return this._initialEntities.splice(idx, 1)[0]!;
  }

  // ──────── Snapshot / clone (for transactional rollback) ────────

  /**
   * Deep-clone a GameDefinition for transaction snapshots.
   *
   * NOTE: this is a provisional implementation for the mutation-tools
   * milestone. It scales with world size, not transaction size, and forecloses
   * parallel transactions across scopes (only one mutable live copy at a time).
   * The intended endpoint is a functional amend layer where the transaction
   * holds a reference to the base def + a delta (added objects, modified
   * copies, tombstones) and reads merge the layers on the fly. Replace this
   * `clone()` and the matching `WorldState.clone()` together when that lands.
   */
  clone(): GameDefinition {
    const out = new GameDefinition();
    for (const [id, t] of this._traits) out._traits.set(id, structuredClone(t));
    for (const [id, r] of this._relations) out._relations.set(id, structuredClone(r));
    for (const [id, a] of this._actions) out._actions.set(id, structuredClone(a));
    for (const [id, k] of this._kinds) out._kinds.set(id, structuredClone(k));
    for (const [id, rb] of this._rulebooks) out._rulebooks.set(id, structuredClone(rb));
    out._rules = this._rules.map((r) => structuredClone(r));
    out._initialEntities = this._initialEntities.map((e) => structuredClone(e));
    out._initialAssertions = this._initialAssertions.map((a) => structuredClone(a));
    out._initialFacts = this._initialFacts.map((f) => structuredClone(f));
    out._metadata = {
      prelude: structuredClone(this._metadata.prelude),
      game: structuredClone(this._metadata.game),
      session: structuredClone(this._metadata.session),
    };
    return out;
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
    for (const r of this._rules) {
      if (r.rulebook !== undefined && !this._rulebooks.has(r.rulebook)) {
        throw new Error(`rule '${r.id}' references unknown rulebook '${r.rulebook}'`);
      }
    }
  }
}

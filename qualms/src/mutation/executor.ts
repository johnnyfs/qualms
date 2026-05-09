/**
 * Mutation executor — applies a single `MutationStatement` to the live
 * `GameDefinition` + `WorldState` for an open `Transaction`. Each branch
 * runs a per-mutation try/revert so the transaction stays consistent on error.
 *
 * Mutations are appended to `tx.applied` only on success.
 */

import { GameDefinition } from "../core/definition.js";
import { WorldState, buildEntity, resolveFieldTarget } from "../core/worldState.js";
import {
  type ActionDefinition,
  type ActionPattern,
  type EffectSpec,
  type EntitySpec,
  type FieldDefinition,
  type KindDefinition,
  type ParameterDefinition,
  type RelationDefinition,
  type Rule,
  type RulebookDefinition,
  type TraitAttachment,
  type TraitDefinition,
} from "../core/types.js";
import {
  action as buildAction,
  attachment as buildAttachment,
  entitySpec as buildEntitySpec,
  field as buildField,
  kind as buildKind,
  parameter as buildParameter,
  pattern as buildPattern,
  relation as buildRelation,
  rule as buildRule,
  rulebook as buildRulebook,
  trait as buildTrait,
} from "../core/builders.js";
import type {
  ActionDefSpec,
  Effect,
  EntityDefSpec,
  FieldDefSpec,
  KindDefSpec,
  MutationStatement,
  ParameterDefSpec,
  RelationDefSpec,
  RuleDefSpec,
  Term,
  TraitDefSpec,
} from "../query/ast.js";
import { MutationError } from "./errors.js";
import type { Transaction } from "./transaction.js";

export function applyMutation(
  m: MutationStatement,
  tx: Transaction,
  def: GameDefinition,
  state: WorldState,
): void {
  switch (m.type) {
    case "assert":
      execAssert(m, tx, def, state);
      break;
    case "retract":
      execRetract(m, tx, def, state);
      break;
    case "fieldAssign":
      execFieldAssign(m, tx, def, state);
      break;
    case "defTrait":
      execDefTrait(m.spec, tx, def);
      break;
    case "defRelation":
      execDefRelation(m.spec, tx, def);
      break;
    case "defAction":
      execDefAction(m.spec, tx, def);
      break;
    case "defKind":
      execDefKind(m.spec, tx, def);
      break;
    case "defRule":
      execDefRule(m.spec, tx, def);
      break;
    case "defRulebook":
      execDefRulebook(m.spec, tx, def);
      break;
    case "defEntity":
      execDefEntity(m.spec, tx, def, state);
      break;
    case "undef":
      execUndef(m, tx, def, state);
      break;
  }
  // Each branch above pushes to tx.applied on success.
  tx.applied.push(m);
}

// ──────── Per-mutation handlers ────────

function execAssert(
  m: Extract<MutationStatement, { type: "assert" }>,
  tx: Transaction,
  def: GameDefinition,
  state: WorldState,
): void {
  if (!def.hasRelation(m.relation)) {
    throw new MutationError(`unknown relation '${m.relation}'`, "unknown_target");
  }
  const rel = def.relation(m.relation);
  if (rel.get !== undefined) {
    throw new MutationError(
      `relation '${m.relation}' is derived; cannot assert directly`,
      "derived_relation",
    );
  }
  const args = m.args.map((t) => groundTerm(t, m.relation));
  state.assertRelation(m.relation, args, tx.module);
  def.addInitialAssertion({ relation: m.relation, args, module: tx.module });
}

function execRetract(
  m: Extract<MutationStatement, { type: "retract" }>,
  tx: Transaction,
  def: GameDefinition,
  state: WorldState,
): void {
  if (!def.hasRelation(m.relation)) {
    throw new MutationError(`unknown relation '${m.relation}'`, "unknown_target");
  }
  const rel = def.relation(m.relation);
  if (rel.get !== undefined) {
    throw new MutationError(
      `relation '${m.relation}' is derived; cannot retract`,
      "derived_relation",
    );
  }
  const args = m.args.map((t) => groundTerm(t, m.relation));
  state.retractRelation(m.relation, args);
  // Drop matching initial assertions.
  for (let i = def.initialAssertions.length - 1; i >= 0; i--) {
    const a = def.initialAssertions[i]!;
    if (a.relation === m.relation && argsEqual(a.args, args)) {
      // GameDefinition has no public removeInitialAssertion that takes a row;
      // splice the underlying array via a helper accessor.
      removeInitialAssertionAt(def, i);
    }
  }
  void tx;
}

function execFieldAssign(
  m: Extract<MutationStatement, { type: "fieldAssign" }>,
  tx: Transaction,
  def: GameDefinition,
  state: WorldState,
): void {
  const target = m.target;
  if (target.type !== "field") {
    throw new MutationError("field-assign target must be `<entity>.[Trait.]field`", "type_mismatch");
  }
  if (target.entity.type !== "var" && target.entity.type !== "value") {
    throw new MutationError("field-assign entity must be a literal id", "type_mismatch");
  }
  const entityId = target.entity.type === "var" ? target.entity.name : String(target.entity.value);
  const value = groundTerm(m.value, "field-assign");

  if (!state.hasEntity(entityId)) {
    throw new MutationError(`unknown entity '${entityId}'`, "unknown_target");
  }
  let resolved;
  try {
    resolved = resolveFieldTarget(state, entityId, target.field, target.trait);
  } catch (e) {
    throw new MutationError(
      e instanceof Error ? e.message : String(e),
      "type_mismatch",
    );
  }
  if (!resolved) {
    throw new MutationError(
      `entity '${entityId}' has no field '${target.field}'`,
      "unknown_target",
    );
  }

  // Capture previous value for rollback within the executor (if validation fails later).
  const prev = state.getField(entityId, resolved.traitId, resolved.fieldId);
  try {
    state.setField(entityId, resolved.traitId, resolved.fieldId, value);
    if (tx.module === "game") {
      // Persist on the EntitySpec so the YAML emit captures it (game-module
      // commits write back to disk; session-module changes ride on save).
      persistEntityFieldOverride(def, entityId, resolved.traitId, resolved.fieldId, value);
    }
  } catch (e) {
    state.setField(entityId, resolved.traitId, resolved.fieldId, prev);
    throw wrapValidationError(e);
  }
}

function execDefTrait(spec: TraitDefSpec, tx: Transaction, def: GameDefinition): void {
  if (def.hasTrait(spec.id)) {
    throw new MutationError(`trait '${spec.id}' already exists`, "duplicate");
  }
  const t = traitFromSpec(spec, tx);
  def.addTrait(t);
  validateOrRevert(def, () => def.removeTrait(spec.id));
}

function execDefRelation(spec: RelationDefSpec, tx: Transaction, def: GameDefinition): void {
  if (def.hasRelation(spec.id)) {
    throw new MutationError(`relation '${spec.id}' already exists`, "duplicate");
  }
  const r = relationFromSpec(spec, tx);
  def.addRelation(r);
  validateOrRevert(def, () => def.removeRelation(spec.id));
}

function execDefAction(spec: ActionDefSpec, tx: Transaction, def: GameDefinition): void {
  if (def.hasAction(spec.id)) {
    throw new MutationError(`action '${spec.id}' already exists`, "duplicate");
  }
  const a = actionFromSpec(spec, tx);
  def.addAction(a);
  validateOrRevert(def, () => def.removeAction(spec.id));
}

function execDefKind(spec: KindDefSpec, tx: Transaction, def: GameDefinition): void {
  if (def.hasKind(spec.id)) {
    throw new MutationError(`kind '${spec.id}' already exists`, "duplicate");
  }
  // Pre-check trait references (validate() will catch but we want a cleaner error).
  for (const traitId of spec.traits) {
    if (!def.hasTrait(traitId)) {
      throw new MutationError(
        `kind '${spec.id}' references unknown trait '${traitId}'`,
        "validation",
      );
    }
  }
  const k = kindFromSpec(spec, tx);
  def.addKind(k);
  validateOrRevert(def, () => def.removeKind(spec.id));
}

function execDefRule(spec: RuleDefSpec, tx: Transaction, def: GameDefinition): void {
  if (def.hasRule(spec.id)) {
    throw new MutationError(`rule '${spec.id}' already exists`, "duplicate");
  }
  if (!def.hasRulebook(spec.rulebook)) {
    throw new MutationError(
      `rule '${spec.id}' references unknown rulebook '${spec.rulebook}'`,
      "validation",
    );
  }
  if (!def.hasAction(spec.pattern.action)) {
    throw new MutationError(
      `rule '${spec.id}' references unknown action '${spec.pattern.action}'`,
      "validation",
    );
  }
  const r = ruleFromSpec(spec, tx);
  def.addRule(r);
  validateOrRevert(def, () => {
    // addRule no-ops on duplicate id; explicit removal here.
    def.removeRule(spec.id);
  });
}

function execDefRulebook(
  spec: { id: string },
  tx: Transaction,
  def: GameDefinition,
): void {
  if (def.hasRulebook(spec.id)) {
    throw new MutationError(`rulebook '${spec.id}' already exists`, "duplicate");
  }
  const rb: RulebookDefinition = { id: spec.id, module: tx.module };
  def.addRulebook(rb);
  validateOrRevert(def, () => def.removeRulebook(spec.id));
}

function execDefEntity(
  spec: EntityDefSpec,
  tx: Transaction,
  def: GameDefinition,
  state: WorldState,
): void {
  if (def.hasInitialEntity(spec.id) || state.hasEntity(spec.id)) {
    throw new MutationError(`entity '${spec.id}' already exists`, "duplicate");
  }
  // v2: TraitGrantSpec[] (id + optional fields, no parameters).
  const traits: TraitAttachment[] = (spec.traits ?? []).map((g) =>
    buildAttachment(g.id, g.fields !== undefined ? { fields: g.fields } : {}),
  );
  // Validate trait + kind references up front.
  if (spec.kind !== undefined && !def.hasKind(spec.kind)) {
    throw new MutationError(`entity '${spec.id}' references unknown kind '${spec.kind}'`, "validation");
  }
  for (const att of traits) {
    if (!def.hasTrait(att.id)) {
      throw new MutationError(
        `entity '${spec.id}' references unknown trait '${att.id}'`,
        "validation",
      );
    }
  }
  const entitySpec: EntitySpec = buildEntitySpec(spec.id, tx.module, {
    ...(spec.kind !== undefined ? { kind: spec.kind } : {}),
    traits,
    fields: spec.fields ?? {},
    metadata: spec.metadata ?? {},
  });
  def.addInitialEntity(entitySpec);
  try {
    const built = buildEntity(def, entitySpec);
    state.entities.set(spec.id, built);
  } catch (e) {
    def.removeInitialEntity(spec.id);
    throw wrapValidationError(e);
  }
}

function execUndef(
  m: Extract<MutationStatement, { type: "undef" }>,
  _tx: Transaction,
  def: GameDefinition,
  state: WorldState,
): void {
  const { targetKind, name } = m;
  // Look up the current layer of the target so we can refuse prelude removals.
  const layerOf = moduleOfTarget(targetKind, name, def);
  if (layerOf === null) {
    throw new MutationError(`unknown ${targetKind} '${name}'`, "unknown_target");
  }
  if (layerOf === "prelude") {
    throw new MutationError(
      `cannot undef ${targetKind} '${name}' — prelude layer is read-only via MCP`,
      "prelude_protected",
    );
  }
  // Snapshot the removed object for revert; remove; validate.
  const restore: () => void = (() => {
    switch (targetKind) {
      case "trait": {
        const removed = def.removeTrait(name);
        return () => def.addTrait(removed);
      }
      case "relation": {
        const removed = def.removeRelation(name);
        return () => def.addRelation(removed);
      }
      case "action": {
        const removed = def.removeAction(name);
        return () => def.addAction(removed);
      }
      case "kind": {
        const removed = def.removeKind(name);
        return () => def.addKind(removed);
      }
      case "rulebook": {
        const removed = def.removeRulebook(name);
        return () => def.addRulebook(removed);
      }
      case "rule": {
        const removed = def.removeRule(name);
        return () => def.addRule(removed);
      }
      case "entity": {
        const removed = def.removeInitialEntity(name);
        const liveSnapshot = state.entities.get(name);
        state.entities.delete(name);
        return () => {
          def.addInitialEntity(removed);
          if (liveSnapshot) state.entities.set(name, liveSnapshot);
        };
      }
    }
  })();
  validateOrRevert(def, restore);
}

// ──────── Helpers ────────

function groundTerm(t: Term, ctx: string): unknown {
  if (t.type === "value") return t.value;
  if (t.type === "var") {
    // Bare identifiers that appear in arg position parse as `var`. For mutation
    // arguments we treat the identifier image as a literal entity id (matching
    // YAML's bare-string convention). The query evaluator does the opposite for
    // queries (binds variables); but mutations need literal ids.
    return t.name;
  }
  throw new MutationError(`field expressions not supported in ${ctx} args`, "type_mismatch");
}

function argsEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false;
  }
  return true;
}

function removeInitialAssertionAt(def: GameDefinition, index: number): void {
  // Direct array splice via the public ordered slice (the only way without
  // exposing internal mutators). Snapshot, drop the index, restore.
  const all = [...def.initialAssertions];
  all.splice(index, 1);
  // No public clear; reconstruct via a fresh empty slot.
  // Pragmatic shortcut: cast-through to access the private array. The
  // alternative is exposing a removeInitialAssertion method with relation+args,
  // which we'll add when there's a second caller for it.
  (def as unknown as { _initialAssertions: typeof all })._initialAssertions = all;
}

function persistEntityFieldOverride(
  def: GameDefinition,
  entityId: string,
  traitId: string,
  fieldId: string,
  value: unknown,
): void {
  // EntitySpec.fields is deeply readonly; we replace the spec wholesale.
  if (!def.hasInitialEntity(entityId)) return;
  const spec = def.initialEntity(entityId);
  const newFields: Record<string, Record<string, unknown>> = {};
  for (const [t, fmap] of Object.entries(spec.fields)) {
    newFields[t] = { ...fmap };
  }
  newFields[traitId] = { ...(newFields[traitId] ?? {}), [fieldId]: value };
  const replacement: EntitySpec = { ...spec, fields: newFields };
  def.removeInitialEntity(entityId);
  def.addInitialEntity(replacement);
}

function validateOrRevert(def: GameDefinition, revert: () => void): void {
  try {
    def.validate();
  } catch (e) {
    revert();
    throw wrapValidationError(e);
  }
}

function wrapValidationError(e: unknown): MutationError {
  if (e instanceof MutationError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new MutationError(msg, "validation");
}

function moduleOfTarget(
  kind: "trait" | "relation" | "action" | "kind" | "rule" | "rulebook" | "entity",
  name: string,
  def: GameDefinition,
): "prelude" | "game" | "session" | null {
  switch (kind) {
    case "trait":
      return def.hasTrait(name) ? def.trait(name).module : null;
    case "relation":
      return def.hasRelation(name) ? def.relation(name).module : null;
    case "action":
      return def.hasAction(name) ? def.action(name).module : null;
    case "kind":
      return def.hasKind(name) ? def.kind(name).module : null;
    case "rule":
      return def.hasRule(name) ? def.rule(name).module : null;
    case "rulebook":
      return def.hasRulebook(name) ? def.rulebook(name).module : null;
    case "entity":
      return def.hasInitialEntity(name) ? def.initialEntity(name).module : null;
  }
}

// ──────── Spec → Definition builders ────────

function paramFromSpec(p: ParameterDefSpec): ParameterDefinition {
  return buildParameter(p.id, {
    ...(p.type !== undefined ? { type: p.type } : {}),
    ...(p.hasDefault === true ? { default: p.default, hasDefault: true } : {}),
  });
}

function fieldFromSpec(f: FieldDefSpec): FieldDefinition {
  return buildField(f.id, {
    ...(f.type !== undefined ? { type: f.type } : {}),
    ...(f.hasDefault === true ? { default: f.default, hasDefault: true } : {}),
  });
}

function effectsToSpecs(effects: Effect[] | undefined): EffectSpec[] {
  if (!effects) return [];
  // Effects are stored as opaque records. Spread the typed Effect into a record.
  return effects.map((e) => ({ ...e }) as unknown as EffectSpec);
}

function traitFromSpec(spec: TraitDefSpec, tx: Transaction): TraitDefinition {
  return buildTrait(spec.id, tx.module, {
    ...(spec.parameters ? { parameters: spec.parameters.map(paramFromSpec) } : {}),
    ...(spec.fields ? { fields: spec.fields.map(fieldFromSpec) } : {}),
    ...(spec.relations ? { relations: spec.relations.map((r) => relationFromSpec(r, tx)) } : {}),
    ...(spec.actions ? { actions: spec.actions.map((a) => actionFromSpec(a, tx)) } : {}),
    ...(spec.rules ? { rules: spec.rules.map((r) => ruleFromSpec(r, tx)) } : {}),
  });
}

function relationFromSpec(spec: RelationDefSpec, tx: Transaction): RelationDefinition {
  return buildRelation(spec.id, tx.module, spec.parameters.map(paramFromSpec), {
    ...(spec.get !== undefined ? { get: spec.get } : {}),
    ...(spec.setEffects !== undefined
      ? { setEffects: effectsToSpecs(spec.setEffects) }
      : {}),
  });
}

function actionFromSpec(spec: ActionDefSpec, tx: Transaction): ActionDefinition {
  return buildAction(spec.id, tx.module, spec.parameters.map(paramFromSpec), {
    ...(spec.requires !== undefined ? { requires: spec.requires } : {}),
    ...(spec.effects !== undefined
      ? { effects: effectsToSpecs(spec.effects) }
      : {}),
  });
}

function kindFromSpec(spec: KindDefSpec, tx: Transaction): KindDefinition {
  // v2: KindDefSpec.traits is string[] (per-attachment overrides moved to entity bodies).
  // Field overrides on the kind apply at instantiation via the same TraitAttachment shape.
  return buildKind(spec.id, tx.module, {
    traits: spec.traits.map((traitId) =>
      buildAttachment(traitId, {
        ...(spec.fields?.[traitId] !== undefined ? { fields: spec.fields[traitId] } : {}),
      }),
    ),
    ...(spec.fields !== undefined ? { fields: spec.fields } : {}),
    ...(spec.rules !== undefined ? { rules: spec.rules.map((r) => ruleFromSpec(r, tx)) } : {}),
  });
}

function ruleFromSpec(spec: RuleDefSpec, tx: Transaction): Rule {
  const pat: ActionPattern = buildPattern(spec.pattern.action, spec.pattern.args);
  return buildRule(spec.id, tx.module, spec.phase, {
    pattern: pat,
    ...(spec.effects !== undefined ? { effects: effectsToSpecs(spec.effects) } : {}),
    ...(spec.guard !== undefined ? { guard: spec.guard } : {}),
    ...(spec.control !== undefined ? { control: spec.control } : {}),
    ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
    rulebook: spec.rulebook,
  });
}

// Re-export the builder for any caller that needs it.
export { buildRulebook };

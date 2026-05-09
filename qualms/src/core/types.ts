/**
 * Core engine UML — TypeScript port of the Python `qualms/core.py` shape, with
 * explicit layer attribution. See qualms/MIGRATION.md for the four-layer model.
 *
 * Layer semantics:
 *   - "prelude": universal schema; file-edit only by the coding agent.
 *   - "game":    per-story schema additions, kinds, initial entities, story rules.
 *   - "session": per-run overlay (agent-spawned content) — persisted in the save file.
 *
 * `session_state` (the live runtime facts/fields) is NOT a definition layer; it lives
 * on `WorldState` and is untagged.
 */

export type Layer = "prelude" | "game" | "session";

export const ALL_LAYERS: readonly Layer[] = ["prelude", "game", "session"] as const;

/** Predicate / Effect / Expression spec — opaque AST shapes, defined in step 2. */
export type PredicateSpec = unknown;
export type EffectSpec = Readonly<Record<string, unknown>>;
export type ExpressionSpec = unknown;
export type Bindings = Readonly<Record<string, unknown>>;

export interface ParameterDefinition {
  readonly id: string;
  /** Type tag (engine-internal); `"value"` is the catch-all default. */
  readonly type: string;
  /** Sentinel `undefined` means "no default — caller must supply". */
  readonly default?: unknown;
  /** True when the parameter has a default (distinguishes `default: undefined` from "no default"). */
  readonly hasDefault: boolean;
}

export interface FieldDefinition {
  readonly id: string;
  readonly type: string;
  readonly default?: unknown;
  readonly hasDefault: boolean;
}

export interface TraitDefinition {
  readonly id: string;
  readonly layer: Layer;
  readonly parameters: readonly ParameterDefinition[];
  readonly fields: readonly FieldDefinition[];
  /** Relations declared as part of the trait (lifted into the merged Definition). */
  readonly relations: readonly RelationDefinition[];
  /** Actions declared as part of the trait (lifted). */
  readonly actions: readonly ActionDefinition[];
  /** Rules declared as part of the trait (lifted). */
  readonly rules: readonly Rule[];
  readonly constraints: readonly PredicateSpec[];
}

export type RelationPersistence = "current" | "remembered" | "both";

export interface RelationDefinition {
  readonly id: string;
  readonly layer: Layer;
  readonly parameters: readonly ParameterDefinition[];
  /** Predicate body for derived relations; undefined means "stored only". */
  readonly get?: PredicateSpec;
  /** Effects fired on assertion; undefined means "not assertable via effects". */
  readonly setEffects?: readonly EffectSpec[];
  /** Storage persistence; undefined means "fully derived (no storage)". */
  readonly persistence?: RelationPersistence;
}

export interface ActionDefinition {
  readonly id: string;
  readonly layer: Layer;
  readonly parameters: readonly ParameterDefinition[];
  readonly requires: PredicateSpec;
  readonly defaultEffects: readonly EffectSpec[];
}

export interface ActionPattern {
  readonly action: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export type RulePhase = "before" | "during" | "after" | "instead";
export type RuleControl = "continue" | "stop";

export interface Rule {
  readonly id: string;
  readonly layer: Layer;
  readonly phase: RulePhase;
  readonly pattern: ActionPattern;
  readonly effects: readonly EffectSpec[];
  readonly guard: PredicateSpec;
  readonly control: RuleControl;
  readonly priority: number;
  readonly order: number;
  /**
   * Optional rulebook membership. New `def rule R in B { … }` mutations require
   * one; existing trait/kind-owned rules omit it. When present, the referenced
   * rulebook id must exist (enforced by `GameDefinition.validate()`).
   */
  readonly rulebook?: string;
}

/**
 * Rulebook — first-class container for grouping rules. Currently a thin shell
 * (id + layer); future iterations may add metadata, ordering, or per-rulebook
 * activation gates.
 */
export interface RulebookDefinition {
  readonly id: string;
  readonly layer: Layer;
}

/** Spec for attaching a trait to an entity (kinds and entity specs both contain these). */
export interface TraitAttachment {
  readonly id: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface KindDefinition {
  readonly id: string;
  readonly layer: Layer;
  readonly traits: readonly TraitAttachment[];
  /** Per-trait field overrides applied at instantiation. */
  readonly fields: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly rules: readonly Rule[];
}

export interface EntitySpec {
  readonly id: string;
  readonly layer: Layer;
  readonly kind?: string;
  readonly traits: readonly TraitAttachment[];
  readonly fields: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly rules: readonly Rule[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface InitialAssertion {
  readonly relation: string;
  readonly args: readonly unknown[];
  readonly layer: Layer;
}

export interface InitialFact {
  readonly id: string;
  readonly args: readonly unknown[];
  readonly layer: Layer;
}

// ──────── Runtime ────────

export interface TraitInstance {
  definitionId: string;
  parameters: Record<string, unknown>;
  fields: Record<string, unknown>;
}

export interface Entity {
  id: string;
  /** Layer the entity *spec* came from. Runtime-mutated trait fields stay tagged here. */
  layer: Layer;
  traits: Record<string, TraitInstance>;
  metadata: Record<string, unknown>;
}

export interface ActionAttempt {
  readonly actionId: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly source?: Readonly<Record<string, unknown>>;
}

export type ActionStatus =
  | "succeeded"
  | "rejected"
  | "blocked"
  | "failed"
  | "unimplemented";

export interface ActionResult {
  readonly status: ActionStatus;
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly error?: string;
}

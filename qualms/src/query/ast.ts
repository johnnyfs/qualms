/**
 * Query DSL AST types — the shape consumed by the evaluator (step 2) and produced
 * by the parser (step 3). Both ASCII and unicode surface forms produce the same
 * AST.
 *
 * Design notes:
 *   - Variables are named strings; all binding is by name.
 *   - Term values are simple (string/number/boolean/null). Entity references are
 *     just string-valued terms — entity ids are strings.
 *   - Path patterns are first-class (not desugared) so the evaluator can compute
 *     transitive closures iteratively rather than recursing through user-level
 *     rules.
 *   - Meta-type filtering on `traitOf` carries an optional layer scope
 *     (`@prelude` / `@game` / `@session`); bare = merged.
 *   - Named subpatterns (`reachable(a, b) :- ...`) live as predicate definitions
 *     attached to the QueryContext; the evaluator inlines them on demand.
 */

import type { Module } from "../core/types.js";

// ──────── Terms (values that can appear as relation arguments) ────────

export type Value = string | number | boolean | null;

export type Term =
  | { type: "var"; name: string }
  | { type: "value"; value: Value }
  | { type: "field"; entity: Term; trait?: string; field: string };

// ──────── Expressions (truth-valued; produce binding sets) ────────

export type Expression =
  | { type: "literal"; value: boolean }
  | { type: "and"; left: Expression; right: Expression }
  | { type: "or"; left: Expression; right: Expression }
  | { type: "not"; operand: Expression }
  | {
      type: "exists";
      variable: string;
      /** Optional trait/meta-type constraint, e.g. `∃ x : Item. φ` */
      traitFilter?: TraitFilter;
      body: Expression;
    }
  | {
      type: "forall";
      variable: string;
      traitFilter?: TraitFilter;
      body: Expression;
    }
  /** Relation atom — works for both stored relations and derived/named predicates. */
  | { type: "relation"; relation: string; args: Term[] }
  /** Trait/meta-type constraint atom: `t : Trait` or `t : Item`. */
  | { type: "traitOf"; entity: Term; filter: TraitFilter }
  | { type: "equal"; left: Term; right: Term }
  | { type: "notEqual"; left: Term; right: Term }
  /** Regex match: `t.id =~ /pat/flags` (subject is a Term producing a string). */
  | { type: "regex"; subject: Term; pattern: string; flags?: string }
  /** SQL-ish pattern: `like(s, "%pat%")`. Subject must produce a string. */
  | { type: "like"; subject: Term; pattern: string }
  /** Path pattern over binary relations. */
  | {
      type: "path";
      from: Term;
      to: Term;
      /** One or more relation ids; alternation when multiple. */
      relations: string[];
      direction: "forward" | "backward" | "symmetric";
      /** "1" = single hop, "*" = zero or more, "+" = one or more. */
      quantifier: "1" | "*" | "+";
    };

/**
 * Trait or meta-type filter on a quantifier or atom. The `name` is either a
 * registered Trait id, or one of the reserved meta-type names:
 *   "Trait" | "Kind" | "Action" | "Relation" | "Rule" | "Entity"
 *
 * `layer` adds scope addressing: `Trait@prelude` etc. Only applicable to
 * meta-type filters.
 */
export interface TraitFilter {
  name: string;
  module?: Module;
}

// ──────── Queries (top-level) ────────

/**
 * A Query has a `head` listing the variables to project; the `body` is a
 * truth-valued expression. An empty head produces a yes/no result (`?- φ`);
 * a non-empty head produces a list of binding rows.
 */
export interface Query {
  head: string[];
  body: Expression;
}

/**
 * Named subpattern: `name(p1, p2, ...) :- body`. Registered in a QueryContext
 * and inlined when matched as a relation atom.
 */
export interface NamedPredicate {
  name: string;
  parameters: string[];
  body: Expression;
}

// ──────── Reserved meta-type names ────────

export const META_TYPES = [
  "Trait",
  "Kind",
  "Action",
  "Relation",
  "Rule",
  "Entity",
] as const;
export type MetaType = (typeof META_TYPES)[number];

export function isMetaType(name: string): name is MetaType {
  return (META_TYPES as readonly string[]).includes(name);
}

/**
 * Relations exposed by the engine for structural introspection. These are
 * recognized by name in the evaluator; they are NOT registered in the
 * GameDefinition's relations map (so they can't be shadowed by user code).
 */
export const INTROSPECTION_RELATIONS = [
  "uses", // uses(kind, trait)
  "defines", // defines(trait, name) — name can be field, relation, action, or rule id
  "instance_of", // instance_of(entity, kind)
  "in_layer", // in_layer(definition-or-entity, module)
] as const;
export type IntrospectionRelation = (typeof INTROSPECTION_RELATIONS)[number];

export function isIntrospectionRelation(name: string): name is IntrospectionRelation {
  return (INTROSPECTION_RELATIONS as readonly string[]).includes(name);
}

// ──────── Effect AST ────────

/**
 * Effects produced by the parser for `effects:` clauses on rules, `set:` on
 * relations, and standalone mutation statements. The mutation executor converts
 * these to the opaque `EffectSpec` records stored on `Rule` / `RelationDefinition`.
 */
export type Effect =
  | { type: "assert"; relation: string; args: Term[] }
  | { type: "retract"; relation: string; args: Term[] }
  | { type: "fieldAssign"; target: Term; value: Term }
  | { type: "emit"; payload: Record<string, Term> };

// ──────── Mutation specs (layer-stripped definition shapes) ────────

/**
 * `*DefSpec` types mirror `core/types.ts` definitions with `layer` removed —
 * the mutation executor stamps the layer from the open transaction's scope.
 * Predicate fields (`get`, `requires`, `guard`, `constraints`) carry parsed
 * `Expression` trees; effect fields carry parsed `Effect` arrays.
 */

export interface ParameterDefSpec {
  id: string;
  type?: string;
  default?: unknown;
  hasDefault?: boolean;
}

export interface FieldDefSpec {
  id: string;
  type?: string;
  default?: unknown;
  hasDefault?: boolean;
}

export interface TraitAttachmentSpec {
  id: string;
  parameters?: Record<string, unknown>;
  fields?: Record<string, unknown>;
}

export interface TraitDefSpec {
  id: string;
  parameters?: ParameterDefSpec[];
  fields?: FieldDefSpec[];
  relations?: RelationDefSpec[];
  actions?: ActionDefSpec[];
  rules?: RuleDefSpec[];
  constraints?: Expression[];
}

export interface RelationDefSpec {
  id: string;
  parameters: ParameterDefSpec[];
  /**
   * Predicate body for derived relations. Presence is the sole "is this
   * derived" signal — the prior `persistence` field has been collapsed.
   */
  get?: Expression;
  setEffects?: Effect[];
}

export interface ActionDefSpec {
  id: string;
  parameters: ParameterDefSpec[];
  requires?: Expression;
  defaultEffects?: Effect[];
}

export interface KindDefSpec {
  id: string;
  traits: TraitAttachmentSpec[];
  fields?: Record<string, Record<string, unknown>>;
  rules?: RuleDefSpec[];
}

/**
 * Trait grant on an entity (v2): attach a trait beyond what the kind provides,
 * with optional field overrides. v1's `parameters` are dropped — entity-level
 * trait params were unused in practice and complicate the v2 grammar.
 *
 * Defined in 3a; wired through in 3b together with the parser rewrite that
 * narrows `EntityDefSpec.traits` and `KindDefSpec.traits` to the v2 shapes.
 */
export interface TraitGrantSpec {
  id: string;
  fields?: Record<string, unknown>;
}

export interface ActionPatternSpec {
  action: string;
  args: Record<string, unknown>;
}

export interface RuleDefSpec {
  id: string;
  /** Required for new mutations: every `def rule` lands in a rulebook (`def rule R in B { … }`). */
  rulebook: string;
  phase: "before" | "during" | "after" | "instead";
  pattern: ActionPatternSpec;
  guard?: Expression;
  effects?: Effect[];
  control?: "continue" | "stop";
  priority?: number;
}

export interface RulebookDefSpec {
  id: string;
}

export interface EntityDefSpec {
  id: string;
  kind?: string;
  traits?: TraitAttachmentSpec[];
  fields?: Record<string, Record<string, unknown>>;
  rules?: RuleDefSpec[];
  metadata?: Record<string, unknown>;
}

export type UndefTargetKind =
  | "trait"
  | "relation"
  | "action"
  | "kind"
  | "rule"
  | "rulebook"
  | "entity";

export const UNDEF_TARGET_KINDS: readonly UndefTargetKind[] = [
  "trait",
  "relation",
  "action",
  "kind",
  "rule",
  "rulebook",
  "entity",
] as const;

export function isUndefTargetKind(name: string): name is UndefTargetKind {
  return (UNDEF_TARGET_KINDS as readonly string[]).includes(name);
}

// ──────── Mutation statement union ────────

export type MutationStatement =
  | { type: "assert"; relation: string; args: Term[] }
  | { type: "retract"; relation: string; args: Term[] }
  | { type: "fieldAssign"; target: Term; value: Term }
  | { type: "defTrait"; spec: TraitDefSpec }
  | { type: "defRelation"; spec: RelationDefSpec }
  | { type: "defAction"; spec: ActionDefSpec }
  | { type: "defKind"; spec: KindDefSpec }
  | { type: "defRule"; spec: RuleDefSpec }
  | { type: "defRulebook"; spec: RulebookDefSpec }
  | { type: "defEntity"; spec: EntityDefSpec }
  | { type: "undef"; targetKind: UndefTargetKind; name: string };

/**
 * Smart constructors for core types — give every required field a sensible
 * default and capture the layer explicitly. Callers typically instantiate via
 * these (or via the YAML loader, step 4).
 */

import type {
  ActionDefinition,
  ActionPattern,
  EffectSpec,
  EntitySpec,
  FieldDefinition,
  KindDefinition,
  Layer,
  ParameterDefinition,
  PredicateSpec,
  RelationDefinition,
  Rule,
  RuleControl,
  RulePhase,
  RulebookDefinition,
  TraitAttachment,
  TraitDefinition,
} from "./types.js";

export function parameter(
  id: string,
  options: { type?: string; default?: unknown; hasDefault?: boolean } = {},
): ParameterDefinition {
  const hasDefault = options.hasDefault ?? Object.prototype.hasOwnProperty.call(options, "default");
  return {
    id,
    type: options.type ?? "value",
    default: options.default,
    hasDefault,
  };
}

export function field(
  id: string,
  options: { type?: string; default?: unknown; hasDefault?: boolean } = {},
): FieldDefinition {
  const hasDefault = options.hasDefault ?? Object.prototype.hasOwnProperty.call(options, "default");
  return {
    id,
    type: options.type ?? "value",
    default: options.default,
    hasDefault,
  };
}

export function trait(
  id: string,
  layer: Layer,
  options: {
    parameters?: readonly ParameterDefinition[];
    fields?: readonly FieldDefinition[];
    relations?: readonly RelationDefinition[];
    actions?: readonly ActionDefinition[];
    rules?: readonly Rule[];
    constraints?: readonly PredicateSpec[];
  } = {},
): TraitDefinition {
  return {
    id,
    layer,
    parameters: options.parameters ?? [],
    fields: options.fields ?? [],
    relations: options.relations ?? [],
    actions: options.actions ?? [],
    rules: options.rules ?? [],
    constraints: options.constraints ?? [],
  };
}

export function relation(
  id: string,
  layer: Layer,
  parameters: readonly ParameterDefinition[],
  options: {
    get?: PredicateSpec;
    setEffects?: readonly EffectSpec[];
  } = {},
): RelationDefinition {
  return {
    id,
    layer,
    parameters,
    get: options.get,
    setEffects: options.setEffects,
  };
}

export function action(
  id: string,
  layer: Layer,
  parameters: readonly ParameterDefinition[],
  options: {
    requires?: PredicateSpec;
    defaultEffects?: readonly EffectSpec[];
  } = {},
): ActionDefinition {
  return {
    id,
    layer,
    parameters,
    requires: options.requires ?? true,
    defaultEffects: options.defaultEffects ?? [],
  };
}

export function pattern(
  actionId: string,
  args: Readonly<Record<string, unknown>> = {},
): ActionPattern {
  return { action: actionId, args };
}

export function rule(
  id: string,
  layer: Layer,
  phase: RulePhase,
  options: {
    pattern: ActionPattern;
    effects?: readonly EffectSpec[];
    guard?: PredicateSpec;
    control?: RuleControl;
    priority?: number;
    order?: number;
    rulebook?: string;
  },
): Rule {
  return {
    id,
    layer,
    phase,
    pattern: options.pattern,
    effects: options.effects ?? [],
    guard: options.guard ?? true,
    control: options.control ?? "continue",
    priority: options.priority ?? 0,
    order: options.order ?? 0,
    ...(options.rulebook !== undefined ? { rulebook: options.rulebook } : {}),
  };
}

export function rulebook(id: string, layer: Layer): RulebookDefinition {
  return { id, layer };
}

export function attachment(
  id: string,
  options: {
    parameters?: Readonly<Record<string, unknown>>;
    fields?: Readonly<Record<string, unknown>>;
  } = {},
): TraitAttachment {
  return {
    id,
    parameters: options.parameters ?? {},
    fields: options.fields ?? {},
  };
}

export function kind(
  id: string,
  layer: Layer,
  options: {
    traits?: readonly TraitAttachment[];
    fields?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    rules?: readonly Rule[];
  } = {},
): KindDefinition {
  return {
    id,
    layer,
    traits: options.traits ?? [],
    fields: options.fields ?? {},
    rules: options.rules ?? [],
  };
}

export function entitySpec(
  id: string,
  layer: Layer,
  options: {
    kind?: string;
    traits?: readonly TraitAttachment[];
    fields?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    rules?: readonly Rule[];
    metadata?: Readonly<Record<string, unknown>>;
  } = {},
): EntitySpec {
  return {
    id,
    layer,
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
    traits: options.traits ?? [],
    fields: options.fields ?? {},
    rules: options.rules ?? [],
    metadata: options.metadata ?? {},
  };
}

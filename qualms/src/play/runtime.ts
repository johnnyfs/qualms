/**
 * Runtime action execution. Given an action id and a binding for its
 * parameters, evaluates the `requires` predicate and applies the action's
 * effects to live `WorldState`. Effects are runtime-tier mutations: they
 * change `WorldState` only, not the structural definition log.
 *
 * Rules engine (before/during/after firing, priority, control) is not
 * implemented here — only the action's own effects run. Rules are a
 * separate milestone.
 */

import type { GameDefinition } from "../core/definition.js";
import { resolveFieldTarget, type WorldState } from "../core/worldState.js";
import type { Effect, Expression, Term, Value } from "../query/ast.js";
import { evaluate, makeContext } from "../query/eval.js";

export type PlayErrorCategory =
  | "unknown_action"
  | "missing_arg"
  | "unknown_arg"
  | "requires_failed"
  | "effect_failed";

export class PlayError extends Error {
  constructor(message: string, public readonly category: PlayErrorCategory) {
    super(message);
    this.name = "PlayError";
  }
}

export interface PlayResult {
  action: string;
  args: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  effectsApplied: number;
}

export function playAction(
  def: GameDefinition,
  state: WorldState,
  actionId: string,
  args: Record<string, unknown>,
): PlayResult {
  if (!def.hasAction(actionId)) {
    throw new PlayError(`unknown action '${actionId}'`, "unknown_action");
  }
  const action = def.action(actionId);

  // Bind parameters: explicit args > defaults > error.
  const env: Record<string, unknown> = {};
  const paramIds = new Set<string>();
  for (const p of action.parameters) {
    paramIds.add(p.id);
    if (Object.prototype.hasOwnProperty.call(args, p.id)) {
      env[p.id] = args[p.id];
    } else if (p.hasDefault) {
      env[p.id] = p.default;
    } else {
      throw new PlayError(
        `missing argument '${p.id}' for action '${actionId}'`,
        "missing_arg",
      );
    }
  }
  for (const k of Object.keys(args)) {
    if (!paramIds.has(k)) {
      throw new PlayError(
        `unknown argument '${k}' for action '${actionId}'`,
        "unknown_arg",
      );
    }
  }

  // Evaluate requires (skip if literal `true`).
  const requires = action.requires;
  if (requires !== true) {
    const ctx = makeContext(def, { state });
    let satisfied = false;
    for (const _b of evaluate(requires as Expression, ctx, env)) {
      satisfied = true;
      break;
    }
    if (!satisfied) {
      throw new PlayError(
        `requires of action '${actionId}' not satisfied`,
        "requires_failed",
      );
    }
  }

  // Apply effects in order. Substitute parameter vars before applying.
  const events: Array<Record<string, unknown>> = [];
  let effectsApplied = 0;
  for (const eff of action.effects) {
    const e = eff as unknown as Effect;
    const substituted = substituteEffect(e, env);
    applyRuntimeEffect(substituted, def, state, events);
    effectsApplied++;
  }

  return { action: actionId, args: { ...env }, events, effectsApplied };
}

function substituteTerm(t: Term, env: Record<string, unknown>): Term {
  if (t.type === "var" && Object.prototype.hasOwnProperty.call(env, t.name)) {
    return { type: "value", value: env[t.name] as Value };
  }
  if (t.type === "field") {
    return { ...t, entity: substituteTerm(t.entity, env) };
  }
  return t;
}

function substituteEffect(e: Effect, env: Record<string, unknown>): Effect {
  switch (e.type) {
    case "assert":
    case "retract":
      return { ...e, args: e.args.map((t) => substituteTerm(t, env)) };
    case "fieldAssign":
      return {
        ...e,
        target: substituteTerm(e.target, env),
        value: substituteTerm(e.value, env),
      };
    case "setAdd":
    case "setRemove":
      return {
        ...e,
        target: substituteTerm(e.target, env),
        element: substituteTerm(e.element, env),
      };
    case "emit": {
      const sub: Record<string, Term> = {};
      for (const [k, v] of Object.entries(e.payload)) sub[k] = substituteTerm(v, env);
      return { type: "emit", payload: sub };
    }
  }
}

function termToValue(t: Term, state: WorldState): unknown {
  if (t.type === "value") return t.value;
  if (t.type === "var") {
    // A `var` term that survived substitution is a free variable in the
    // effect — treat as a literal id (matches the executor convention for
    // bare identifiers in mutation arg position).
    return t.name;
  }
  // field: read the entity's field value from live state.
  const entityId = String(termToValue(t.entity, state));
  if (!state.hasEntity(entityId)) {
    throw new PlayError(`unknown entity '${entityId}'`, "effect_failed");
  }
  const resolved = resolveFieldTarget(state, entityId, t.field, t.trait);
  if (!resolved) {
    throw new PlayError(
      `entity '${entityId}' has no field '${t.field}'`,
      "effect_failed",
    );
  }
  return state.getField(entityId, resolved.traitId, resolved.fieldId);
}

function applyRuntimeEffect(
  e: Effect,
  def: GameDefinition,
  state: WorldState,
  events: Array<Record<string, unknown>>,
): void {
  switch (e.type) {
    case "assert": {
      if (!def.hasRelation(e.relation)) {
        throw new PlayError(`unknown relation '${e.relation}'`, "effect_failed");
      }
      const r = def.relation(e.relation);
      if (r.get !== undefined) {
        // Derived relation — run its `set:` clause with call args bound to
        // the relation's parameters. (No `set:` ⇒ cannot assert.)
        const setEffects = r.setEffects as readonly Effect[] | undefined;
        if (!setEffects || setEffects.length === 0) {
          throw new PlayError(
            `relation '${e.relation}' is derived and has no set: clause; cannot assert`,
            "effect_failed",
          );
        }
        const callEnv: Record<string, unknown> = {};
        for (let i = 0; i < r.parameters.length; i++) {
          const p = r.parameters[i]!;
          callEnv[p.id] = e.args[i] !== undefined ? termToValue(e.args[i]!, state) : undefined;
        }
        for (const inner of setEffects) {
          applyRuntimeEffect(substituteEffect(inner, callEnv), def, state, events);
        }
        return;
      }
      const args = e.args.map((t) => termToValue(t, state));
      state.assertRelation(e.relation, args, "runtime");
      return;
    }
    case "retract": {
      if (!def.hasRelation(e.relation)) {
        throw new PlayError(`unknown relation '${e.relation}'`, "effect_failed");
      }
      const args = e.args.map((t) => termToValue(t, state));
      state.retractRelation(e.relation, args);
      return;
    }
    case "fieldAssign": {
      if (e.target.type !== "field") {
        throw new PlayError(
          "fieldAssign target must be `<entity>.[Trait.]field`",
          "effect_failed",
        );
      }
      const entityId = String(termToValue(e.target.entity, state));
      const value = termToValue(e.value, state);
      if (!state.hasEntity(entityId)) {
        throw new PlayError(`unknown entity '${entityId}'`, "effect_failed");
      }
      const resolved = resolveFieldTarget(state, entityId, e.target.field, e.target.trait);
      if (!resolved) {
        throw new PlayError(
          `entity '${entityId}' has no field '${e.target.field}'`,
          "effect_failed",
        );
      }
      state.setField(entityId, resolved.traitId, resolved.fieldId, value);
      return;
    }
    case "setAdd":
    case "setRemove": {
      if (e.target.type !== "field") {
        throw new PlayError(
          "set-mutate target must be `<entity>.[Trait.]field`",
          "effect_failed",
        );
      }
      const entityId = String(termToValue(e.target.entity, state));
      const element = termToValue(e.element, state);
      if (!state.hasEntity(entityId)) {
        throw new PlayError(`unknown entity '${entityId}'`, "effect_failed");
      }
      const resolved = resolveFieldTarget(state, entityId, e.target.field, e.target.trait);
      if (!resolved) {
        throw new PlayError(
          `entity '${entityId}' has no field '${e.target.field}'`,
          "effect_failed",
        );
      }
      const prev = state.getField(entityId, resolved.traitId, resolved.fieldId);
      if (!(prev instanceof Set)) {
        throw new PlayError(
          `field '${resolved.traitId}.${resolved.fieldId}' is not a set`,
          "effect_failed",
        );
      }
      const next = new Set(prev);
      if (e.type === "setAdd") next.add(element);
      else next.delete(element);
      state.setField(entityId, resolved.traitId, resolved.fieldId, next);
      return;
    }
    case "emit": {
      const payload: Record<string, unknown> = {};
      for (const [k, t] of Object.entries(e.payload)) payload[k] = termToValue(t, state);
      events.push(payload);
      return;
    }
  }
}

/**
 * Parameter substitution into Term and Effect AST trees. Used by the play
 * runtime (when invoking an action's effects after binding parameters) and
 * by the mutation executor (when expanding a derived relation's `set:`
 * clause after binding the relation's call args to its declared
 * parameters).
 */

import type { Effect, Term, Value } from "./ast.js";

export function substituteTerm(t: Term, env: Record<string, unknown>): Term {
  if (t.type === "var" && Object.prototype.hasOwnProperty.call(env, t.name)) {
    return { type: "value", value: env[t.name] as Value };
  }
  if (t.type === "field") {
    return { ...t, entity: substituteTerm(t.entity, env) };
  }
  return t;
}

export function substituteEffect(e: Effect, env: Record<string, unknown>): Effect {
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

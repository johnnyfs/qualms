/**
 * Translate the legacy YAML predicate shape (any/all/eq/relation/has_trait/...)
 * into the query AST consumed by the step-2 evaluator. This lets one evaluator
 * handle both YAML-authored derived bodies and DSL-authored queries.
 *
 * Effect lists (set_field, assert, emit, ...) are NOT translated here — they
 * stay as opaque EffectSpec records in the GameDefinition. The action-execution
 * engine consumes them in a later step.
 */

import type { Expression, Term } from "../query/ast.js";

export class PredicateTranslateError extends Error {
  constructor(message: string, public readonly path: string) {
    super(`${message} at ${path}`);
    this.name = "PredicateTranslateError";
  }
}

export function translatePredicate(node: unknown, path = "predicate"): Expression {
  if (node === true) return { type: "literal", value: true };
  if (node === false) return { type: "literal", value: false };
  if (node === null || node === undefined) {
    throw new PredicateTranslateError("predicate cannot be null", path);
  }
  if (typeof node !== "object" || Array.isArray(node)) {
    throw new PredicateTranslateError(`predicate must be a boolean or object, got ${typeof node}`, path);
  }
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    throw new PredicateTranslateError(
      `predicate must be a single-key object, got keys [${keys.join(", ")}]`,
      path,
    );
  }
  const [key] = keys as [string];
  const arg = obj[key];
  switch (key) {
    case "any": {
      const arr = ensureArray(arg, `${path}.any`);
      if (arr.length === 0) return { type: "literal", value: false };
      return arr.slice(1).reduce<Expression>(
        (left, item, i) => ({
          type: "or",
          left,
          right: translatePredicate(item, `${path}.any[${i + 1}]`),
        }),
        translatePredicate(arr[0], `${path}.any[0]`),
      );
    }
    case "all": {
      const arr = ensureArray(arg, `${path}.all`);
      if (arr.length === 0) return { type: "literal", value: true };
      return arr.slice(1).reduce<Expression>(
        (left, item, i) => ({
          type: "and",
          left,
          right: translatePredicate(item, `${path}.all[${i + 1}]`),
        }),
        translatePredicate(arr[0], `${path}.all[0]`),
      );
    }
    case "not": {
      return { type: "not", operand: translatePredicate(arg, `${path}.not`) };
    }
    case "eq": {
      const arr = ensureArray(arg, `${path}.eq`);
      if (arr.length !== 2) {
        throw new PredicateTranslateError("eq must have exactly 2 args", path);
      }
      return {
        type: "equal",
        left: translateTerm(arr[0], `${path}.eq[0]`),
        right: translateTerm(arr[1], `${path}.eq[1]`),
      };
    }
    case "relation": {
      const r = arg as Record<string, unknown>;
      if (typeof r["id"] !== "string") {
        throw new PredicateTranslateError("relation.id must be a string", path);
      }
      const args = ensureArray(r["args"], `${path}.relation.args`);
      return {
        type: "relation",
        relation: r["id"],
        args: args.map((a, i) => translateTerm(a, `${path}.relation.args[${i}]`)),
      };
    }
    case "has_trait": {
      const r = arg as Record<string, unknown>;
      if (typeof r["trait"] !== "string") {
        throw new PredicateTranslateError("has_trait.trait must be a string", path);
      }
      return {
        type: "traitOf",
        entity: translateTerm(r["entity"], `${path}.has_trait.entity`),
        filter: { name: r["trait"] },
      };
    }
  }
  throw new PredicateTranslateError(`unknown predicate operator '${key}'`, path);
}

export function translateTerm(node: unknown, path = "term"): Term {
  if (node === null) return { type: "value", value: null };
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return { type: "value", value: node };
  }
  if (typeof node !== "object" || Array.isArray(node)) {
    throw new PredicateTranslateError(`term must be a primitive or object, got ${typeof node}`, path);
  }
  const obj = node as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) {
    throw new PredicateTranslateError(
      `term must be a single-key object, got keys [${keys.join(", ")}]`,
      path,
    );
  }
  const [key] = keys as [string];
  const arg = obj[key];
  if (key === "var") {
    if (typeof arg !== "string") {
      throw new PredicateTranslateError("var must be a string", path);
    }
    return { type: "var", name: arg };
  }
  if (key === "field") {
    const f = arg as Record<string, unknown>;
    if (typeof f["field"] !== "string") {
      throw new PredicateTranslateError("field.field must be a string", path);
    }
    const term: Term = {
      type: "field",
      entity: translateTerm(f["entity"], `${path}.field.entity`),
      ...(typeof f["trait"] === "string" ? { trait: f["trait"] } : {}),
      field: f["field"],
    };
    return term;
  }
  if (key === "value") {
    return { type: "value", value: arg as Term extends { type: "value"; value: infer V } ? V : never };
  }
  throw new PredicateTranslateError(`unknown term operator '${key}'`, path);
}

function ensureArray(node: unknown, path: string): unknown[] {
  if (!Array.isArray(node)) {
    throw new PredicateTranslateError(`expected list, got ${typeof node}`, path);
  }
  return node;
}

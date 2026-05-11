/**
 * AST builder helpers — a compact, readable way to construct query expressions
 * in TypeScript code. Mirrors the surface DSL one-to-one.
 */

import type { Expression, NamedPredicate, Query, Term, TraitFilter, Value } from "./ast.js";

export const v = (name: string): Term => ({ type: "var", name });
export const c = (value: Value): Term => ({ type: "value", value });
export const f = (entity: Term, field: string, trait?: string): Term => ({
  type: "field",
  entity,
  field,
  ...(trait !== undefined ? { trait } : {}),
});

export const TRUE: Expression = { type: "literal", value: true };
export const FALSE: Expression = { type: "literal", value: false };

export function and(...parts: Expression[]): Expression {
  if (parts.length === 0) return TRUE;
  if (parts.length === 1) return parts[0]!;
  return parts.slice(1).reduce<Expression>(
    (left, right) => ({ type: "and", left, right }),
    parts[0]!,
  );
}

export function or(...parts: Expression[]): Expression {
  if (parts.length === 0) return FALSE;
  if (parts.length === 1) return parts[0]!;
  return parts.slice(1).reduce<Expression>(
    (left, right) => ({ type: "or", left, right }),
    parts[0]!,
  );
}

export const not = (operand: Expression): Expression => ({ type: "not", operand });

export const exists = (variable: string, body: Expression, filter?: TraitFilter): Expression => ({
  type: "exists",
  variable,
  ...(filter ? { traitFilter: filter } : {}),
  body,
});

export const forall = (variable: string, body: Expression, filter?: TraitFilter): Expression => ({
  type: "forall",
  variable,
  ...(filter ? { traitFilter: filter } : {}),
  body,
});

export const rel = (relation: string, args: Term[]): Expression => ({
  type: "relation",
  relation,
  args,
});

export const traitOf = (entity: Term, filter: TraitFilter | string): Expression => ({
  type: "traitOf",
  entity,
  filter: typeof filter === "string" ? { name: filter } : filter,
});

export const eq = (left: Term, right: Term): Expression => ({ type: "equal", left, right });
export const neq = (left: Term, right: Term): Expression => ({
  type: "notEqual",
  left,
  right,
});

export const regex = (subject: Term, pattern: string, flags?: string): Expression => ({
  type: "regex",
  subject,
  pattern,
  ...(flags !== undefined ? { flags } : {}),
});

export const like = (subject: Term, pattern: string): Expression => ({
  type: "like",
  subject,
  pattern,
});

export interface PathOptions {
  direction?: "forward" | "backward" | "symmetric";
  quantifier?: "1" | "*" | "+";
}

export const path = (
  from: Term,
  relations: string | string[],
  to: Term,
  options: PathOptions = {},
): Expression => ({
  type: "path",
  from,
  to,
  relations: Array.isArray(relations) ? relations : [relations],
  direction: options.direction ?? "forward",
  quantifier: options.quantifier ?? "1",
});

export const inSet = (element: Term, set: Term): Expression => ({
  type: "in",
  element,
  set,
});

// ──────── Query head builders ────────

export const query = (head: string[], body: Expression): Query => ({ head, body });
export const yesNo = (body: Expression): Query => ({ head: [], body });

export const namedPredicate = (
  name: string,
  parameters: string[],
  body: Expression,
): NamedPredicate => ({ name, parameters, body });

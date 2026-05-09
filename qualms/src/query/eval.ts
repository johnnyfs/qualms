/**
 * Query evaluator — top-down (SLD-style) generator-based evaluation of the
 * query DSL AST against a GameDefinition + WorldState.
 *
 * Bindings are plain objects from variable name to value. Each evaluation step
 * yields extended bindings (or yields nothing to indicate the branch failed).
 */

import type { GameDefinition } from "../core/definition.js";
import type { Layer } from "../core/types.js";
import type { WorldState } from "../core/worldState.js";
import {
  isIntrospectionRelation,
  isMetaType,
  type Expression,
  type NamedPredicate,
  type Query,
  type Term,
  type TraitFilter,
  type Value,
} from "./ast.js";
import {
  enumerateDefines,
  enumerateInLayer,
  enumerateInstanceOf,
  enumerateMetaIds,
  enumerateUses,
  layerOfId,
  metaFieldValue,
  type MetaContext,
} from "./meta.js";

export type Binding = Readonly<Record<string, unknown>>;

export interface QueryContext {
  definition: GameDefinition;
  state?: WorldState;
  /** Named subpatterns registered in this context — inlined when called by name. */
  predicates: ReadonlyMap<string, NamedPredicate>;
}

export function makeContext(
  definition: GameDefinition,
  options: { state?: WorldState; predicates?: NamedPredicate[] } = {},
): QueryContext {
  const map = new Map<string, NamedPredicate>();
  for (const p of options.predicates ?? []) map.set(p.name, p);
  return {
    definition,
    ...(options.state ? { state: options.state } : {}),
    predicates: map,
  };
}

function metaCtx(ctx: QueryContext): MetaContext {
  return ctx.state ? { definition: ctx.definition, state: ctx.state } : { definition: ctx.definition };
}

/** Resolve a Term given current bindings. Returns sentinel `UNBOUND` when not resolvable. */
const UNBOUND = Symbol("unbound");
type Resolved = Value | typeof UNBOUND;

function resolveTerm(term: Term, env: Binding, ctx: QueryContext): Resolved {
  if (term.type === "value") return term.value;
  if (term.type === "var") {
    const present = Object.prototype.hasOwnProperty.call(env, term.name);
    if (!present) return UNBOUND;
    return env[term.name] as Value;
  }
  // field access
  const entityValue = resolveTerm(term.entity, env, ctx);
  if (entityValue === UNBOUND) return UNBOUND;
  if (typeof entityValue !== "string") {
    throw new Error(`field access on non-string entity reference: ${String(entityValue)}`);
  }
  return resolveFieldAccess(entityValue, term.trait, term.field, ctx);
}

function resolveFieldAccess(
  entityId: string,
  traitId: string | undefined,
  fieldId: string,
  ctx: QueryContext,
): Value {
  // Meta-entity field access (Trait.id, Kind.layer, Relation.persistence, etc.)
  const m = metaCtx(ctx);
  if (
    traitId === undefined &&
    (ctx.definition.hasTrait(entityId) ||
      ctx.definition.hasKind(entityId) ||
      ctx.definition.hasAction(entityId) ||
      ctx.definition.hasRelation(entityId) ||
      ctx.definition.rules.some((r) => r.id === entityId))
  ) {
    return metaFieldValue(m, entityId, fieldId) as Value;
  }
  // World entity field access (requires state).
  if (!ctx.state) {
    throw new Error(`field access on '${entityId}' requires a WorldState`);
  }
  if (!ctx.state.hasEntity(entityId)) {
    // Could still be a meta entity field with explicit trait — try meta fallback.
    return metaFieldValue(m, entityId, fieldId) as Value;
  }
  if (traitId !== undefined) {
    return ctx.state.getField(entityId, traitId, fieldId) as Value;
  }
  // Auto-resolve trait: find the unique trait on this entity that defines this field.
  const entity = ctx.state.entity(entityId);
  const matches: string[] = [];
  for (const tId of Object.keys(entity.traits)) {
    const traitDef = ctx.definition.trait(tId);
    if (traitDef.fields.some((f) => f.id === fieldId)) matches.push(tId);
  }
  if (matches.length === 0) {
    // Fall back to meta field (e.g., entity.id, entity.layer).
    return metaFieldValue(m, entityId, fieldId) as Value;
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous field '${fieldId}' on '${entityId}': defined by traits ${matches.join(", ")} — qualify with .Trait.${fieldId}`,
    );
  }
  return ctx.state.getField(entityId, matches[0]!, fieldId) as Value;
}

/** Try to bind `term` to `value` under current env; returns extended env or undefined. */
function unify(term: Term, value: Value, env: Binding, ctx: QueryContext): Binding | undefined {
  if (term.type === "value") {
    return term.value === value ? env : undefined;
  }
  if (term.type === "var") {
    if (Object.prototype.hasOwnProperty.call(env, term.name)) {
      return env[term.name] === value ? env : undefined;
    }
    return { ...env, [term.name]: value };
  }
  // Field term — resolve and compare.
  const resolved = resolveTerm(term, env, ctx);
  if (resolved === UNBOUND) return undefined;
  return resolved === value ? env : undefined;
}

// ──────── Evaluation ────────

export function* evaluate(expr: Expression, ctx: QueryContext, env: Binding = {}): Generator<Binding> {
  switch (expr.type) {
    case "literal":
      if (expr.value) yield env;
      return;

    case "and": {
      for (const e1 of evaluate(expr.left, ctx, env)) {
        for (const e2 of evaluate(expr.right, ctx, e1)) {
          yield e2;
        }
      }
      return;
    }

    case "or": {
      const seen = new Set<string>();
      for (const e of evaluate(expr.left, ctx, env)) {
        const key = bindingKey(e);
        if (!seen.has(key)) {
          seen.add(key);
          yield e;
        }
      }
      for (const e of evaluate(expr.right, ctx, env)) {
        const key = bindingKey(e);
        if (!seen.has(key)) {
          seen.add(key);
          yield e;
        }
      }
      return;
    }

    case "not": {
      const inner = evaluate(expr.operand, ctx, env);
      const first = inner.next();
      if (first.done) yield env;
      return;
    }

    case "exists": {
      // For each witness of the existential variable, project the variable out
      // of the result binding (so consumers see only the OTHER newly bound vars).
      // Dedupe projected bindings so a single witness suffices for each combination
      // of other-var bindings.
      const seen = new Set<string>();
      const sources: Iterable<Binding> = expr.traitFilter
        ? (function* () {
            for (const id of enumerateUniverse(expr.traitFilter!, ctx)) {
              const seeded: Binding = { ...env, [expr.variable]: id };
              for (const inner of evaluate(expr.body, ctx, seeded)) yield inner;
            }
          })()
        : evaluate(expr.body, ctx, env);
      for (const inner of sources) {
        const projected = projectAway(inner, expr.variable, env);
        const key = bindingKey(projected);
        if (seen.has(key)) continue;
        seen.add(key);
        yield projected;
      }
      return;
    }

    case "forall": {
      if (!expr.traitFilter) {
        throw new Error("forall requires a traitFilter (universe of quantification)");
      }
      let allHold = true;
      for (const id of enumerateUniverse(expr.traitFilter, ctx)) {
        const seeded: Binding = { ...env, [expr.variable]: id };
        const witness = evaluate(expr.body, ctx, seeded).next();
        if (witness.done) {
          allHold = false;
          break;
        }
      }
      if (allHold) yield env;
      return;
    }

    case "relation": {
      yield* evaluateRelation(expr.relation, expr.args, ctx, env);
      return;
    }

    case "traitOf": {
      yield* evaluateTraitOf(expr.entity, expr.filter, ctx, env);
      return;
    }

    case "equal":
    case "notEqual": {
      const lr = resolveTerm(expr.left, env, ctx);
      const rr = resolveTerm(expr.right, env, ctx);
      if (lr === UNBOUND && rr === UNBOUND) {
        throw new Error(`equality with two unbound terms is unsupported`);
      }
      if (lr === UNBOUND) {
        const ext = unify(expr.left, rr as Value, env, ctx);
        if (ext) yield expr.type === "equal" ? ext : env;
        return;
      }
      if (rr === UNBOUND) {
        const ext = unify(expr.right, lr as Value, env, ctx);
        if (ext) yield expr.type === "equal" ? ext : env;
        return;
      }
      const isEq = lr === rr;
      if (expr.type === "equal" ? isEq : !isEq) yield env;
      return;
    }

    case "regex": {
      const sub = resolveTerm(expr.subject, env, ctx);
      if (sub === UNBOUND) {
        throw new Error("regex subject is unbound");
      }
      if (typeof sub !== "string") {
        throw new Error(`regex subject must be string, got ${typeof sub}`);
      }
      const re = new RegExp(expr.pattern, expr.flags ?? "");
      if (re.test(sub)) yield env;
      return;
    }

    case "like": {
      const sub = resolveTerm(expr.subject, env, ctx);
      if (sub === UNBOUND) throw new Error("like subject is unbound");
      if (typeof sub !== "string") throw new Error("like subject must be string");
      if (likeMatch(sub, expr.pattern)) yield env;
      return;
    }

    case "path": {
      yield* evaluatePath(expr, ctx, env);
      return;
    }
  }
}

function bindingKey(b: Binding): string {
  const sorted = Object.keys(b).sort();
  return sorted.map((k) => `${k}=${JSON.stringify(b[k])}`).join("&");
}

function projectAway(b: Binding, variable: string, baseEnv: Binding): Binding {
  // Drop `variable` from b. Keep other newly bound variables. We must not return
  // baseEnv directly — body may have bound additional vars.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === variable && !Object.prototype.hasOwnProperty.call(baseEnv, k)) continue;
    out[k] = v;
  }
  return out;
}

function enumerateUniverse(filter: TraitFilter, ctx: QueryContext): Iterable<string> {
  if (isMetaType(filter.name)) {
    return enumerateMetaIds(metaCtx(ctx), filter.name, filter.layer);
  }
  if (filter.layer !== undefined) {
    throw new Error(`layer filter '@${filter.layer}' only valid on meta-types, not trait '${filter.name}'`);
  }
  if (!ctx.state) return [];
  const out: string[] = [];
  for (const e of ctx.state.entities.values()) {
    if (Object.prototype.hasOwnProperty.call(e.traits, filter.name)) out.push(e.id);
  }
  return out;
}

function* evaluateTraitOf(
  entity: Term,
  filter: TraitFilter,
  ctx: QueryContext,
  env: Binding,
): Generator<Binding> {
  const resolved = resolveTerm(entity, env, ctx);
  if (resolved === UNBOUND) {
    // Enumerate the universe.
    for (const id of enumerateUniverse(filter, ctx)) {
      const ext = unify(entity, id, env, ctx);
      if (ext) yield ext;
    }
    return;
  }
  // Bound — check membership.
  if (typeof resolved !== "string") return;
  if (isMetaType(filter.name)) {
    const ids = new Set(enumerateMetaIds(metaCtx(ctx), filter.name, filter.layer));
    if (ids.has(resolved)) yield env;
    return;
  }
  if (filter.layer !== undefined) {
    throw new Error(`layer filter '@${filter.layer}' only valid on meta-types`);
  }
  if (ctx.state?.hasEntity(resolved) && ctx.state.hasTrait(resolved, filter.name)) {
    yield env;
  }
}

function* evaluateRelation(
  relationName: string,
  args: Term[],
  ctx: QueryContext,
  env: Binding,
): Generator<Binding> {
  // Named user predicate?
  const pred = ctx.predicates.get(relationName);
  if (pred) {
    yield* evaluateNamedPredicate(pred, args, ctx, env);
    return;
  }
  // Introspection relation?
  if (isIntrospectionRelation(relationName)) {
    yield* evaluateIntrospection(relationName, args, ctx, env);
    return;
  }
  // Engine-defined relation.
  if (!ctx.definition.hasRelation(relationName)) {
    throw new Error(`unknown relation '${relationName}'`);
  }
  const rel = ctx.definition.relation(relationName);
  if (rel.get !== undefined) {
    // Derived — inline body with parameter bindings.
    yield* evaluateDerivedRelation(rel.get, rel.parameters, args, ctx, env);
    return;
  }
  // Stored — scan tuples from the unified relations Map.
  if (!ctx.state) {
    throw new Error(`stored relation '${relationName}' requires a WorldState`);
  }
  const tuples = ctx.state.storedTuples(relationName);
  for (const tuple of tuples) {
    yield* unifyArgsWithTuple(args, tuple.args, env, ctx);
  }
}

function* unifyArgsWithTuple(
  args: Term[],
  tupleArgs: readonly unknown[],
  env: Binding,
  ctx: QueryContext,
): Generator<Binding> {
  if (args.length !== tupleArgs.length) return;
  let current: Binding = env;
  for (let i = 0; i < args.length; i++) {
    const next = unify(args[i]!, tupleArgs[i] as Value, current, ctx);
    if (!next) return;
    current = next;
  }
  yield current;
}

function* evaluateDerivedRelation(
  body: unknown,
  params: readonly { id: string }[],
  args: Term[],
  ctx: QueryContext,
  env: Binding,
): Generator<Binding> {
  if (args.length !== params.length) {
    throw new Error(`derived relation expected ${params.length} args, got ${args.length}`);
  }
  if (typeof body !== "object" || body === null || !("type" in body)) {
    if (body === true) {
      yield env;
      return;
    }
    if (body === false) return;
    throw new Error("derived relation body must be an Expression AST");
  }
  // Bind parameter names to call args, then evaluate the body, then project away the parameter names.
  const innerEnv: Record<string, unknown> = { ...env };
  const overwritten: Map<string, unknown> = new Map();
  for (let i = 0; i < params.length; i++) {
    const argResolved = resolveTerm(args[i]!, env, ctx);
    if (argResolved === UNBOUND) {
      // Caller passes an unbound var → we evaluate the body for all witnesses
      // and unify the var with the resulting parameter value. Implemented by
      // generating bindings of the param via the body, then unifying back.
      yield* evaluateDerivedWithUnboundArgs(body as Expression, params, args, ctx, env);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(innerEnv, params[i]!.id)) {
      overwritten.set(params[i]!.id, innerEnv[params[i]!.id]);
    }
    innerEnv[params[i]!.id] = argResolved;
  }
  for (const inner of evaluate(body as Expression, ctx, innerEnv)) {
    // Project parameters away (they were the call-arg values, not new bindings).
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inner)) {
      if (params.some((p) => p.id === k)) {
        if (overwritten.has(k)) out[k] = overwritten.get(k);
        else if (Object.prototype.hasOwnProperty.call(env, k)) out[k] = env[k];
        // else: don't re-emit
        continue;
      }
      out[k] = v;
    }
    yield out;
  }
}

function* evaluateDerivedWithUnboundArgs(
  body: Expression,
  params: readonly { id: string }[],
  args: Term[],
  ctx: QueryContext,
  env: Binding,
): Generator<Binding> {
  // Evaluate body with parameter names as free vars in body's env.
  // Then for each binding, unify the param name's value back into the call args.
  for (const inner of evaluate(body, ctx, env)) {
    let current: Binding = env;
    let ok = true;
    for (let i = 0; i < params.length; i++) {
      const paramName = params[i]!.id;
      if (!Object.prototype.hasOwnProperty.call(inner, paramName)) {
        ok = false;
        break;
      }
      const ext = unify(args[i]!, inner[paramName] as Value, current, ctx);
      if (!ext) {
        ok = false;
        break;
      }
      current = ext;
    }
    if (ok) yield current;
  }
}

function* evaluateNamedPredicate(
  pred: NamedPredicate,
  args: Term[],
  ctx: QueryContext,
  env: Binding,
): Generator<Binding> {
  if (args.length !== pred.parameters.length) {
    throw new Error(
      `named predicate '${pred.name}' expected ${pred.parameters.length} args, got ${args.length}`,
    );
  }
  // Same machinery as derived relation.
  yield* evaluateDerivedRelation(
    pred.body,
    pred.parameters.map((p) => ({ id: p })),
    args,
    ctx,
    env,
  );
}

function* evaluateIntrospection(
  name: string,
  args: Term[],
  ctx: QueryContext,
  env: Binding,
): Generator<Binding> {
  const m = metaCtx(ctx);
  if (name === "uses") {
    if (args.length !== 2) throw new Error("uses(kind, trait) takes 2 args");
    for (const tup of enumerateUses(m)) {
      yield* unifyArgsWithTuple(args, [tup.kind, tup.trait], env, ctx);
    }
    return;
  }
  if (name === "instance_of") {
    if (args.length !== 2) throw new Error("instance_of(entity, kind) takes 2 args");
    for (const tup of enumerateInstanceOf(m)) {
      yield* unifyArgsWithTuple(args, [tup.entity, tup.kind], env, ctx);
    }
    return;
  }
  if (name === "defines") {
    if (args.length !== 2) throw new Error("defines(trait, name) takes 2 args");
    for (const tup of enumerateDefines(m)) {
      yield* unifyArgsWithTuple(args, [tup.trait, tup.name], env, ctx);
    }
    return;
  }
  if (name === "in_layer") {
    if (args.length !== 2) throw new Error("in_layer(id, layer) takes 2 args");
    for (const tup of enumerateInLayer(m)) {
      yield* unifyArgsWithTuple(args, [tup.id, tup.layer], env, ctx);
    }
    return;
  }
  throw new Error(`unknown introspection relation '${name}'`);
}

// ──────── Path evaluation ────────

function* evaluatePath(
  expr: Extract<Expression, { type: "path" }>,
  ctx: QueryContext,
  env: Binding,
): Generator<Binding> {
  if (!ctx.state) throw new Error("path patterns require a WorldState");
  const fromResolved = resolveTerm(expr.from, env, ctx);
  const toResolved = resolveTerm(expr.to, env, ctx);

  // Build edge list across the requested relation set.
  const edges: { source: string; target: string }[] = [];
  for (const relId of expr.relations) {
    if (!ctx.definition.hasRelation(relId)) {
      throw new Error(`path references unknown relation '${relId}'`);
    }
    const rel = ctx.definition.relation(relId);
    if (rel.get !== undefined) {
      throw new Error(`path relation '${relId}' must be stored (not derived)`);
    }
    if (rel.parameters.length !== 2) {
      throw new Error(`path relation '${relId}' must be binary`);
    }
    for (const tup of ctx.state.storedTuples(relId)) {
      const [a, b] = tup.args as [string, string];
      if (expr.direction === "forward" || expr.direction === "symmetric") {
        edges.push({ source: a, target: b });
      }
      if (expr.direction === "backward" || expr.direction === "symmetric") {
        edges.push({ source: b, target: a });
      }
    }
  }

  // Determine starting points and goals.
  const allNodes = new Set<string>();
  for (const e of edges) {
    allNodes.add(e.source);
    allNodes.add(e.target);
  }
  if (typeof fromResolved === "string") allNodes.add(fromResolved);
  if (typeof toResolved === "string") allNodes.add(toResolved);

  const starts =
    fromResolved !== UNBOUND
      ? [fromResolved as string]
      : [...allNodes];

  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    adj.get(e.source)!.add(e.target);
  }

  for (const start of starts) {
    const reachable = new Set<string>();
    if (expr.quantifier === "*") reachable.add(start);
    // BFS for paths of length ≥1 (or =1 for "1" quantifier).
    const queue: string[] = [start];
    const visited = new Set<string>([start]);
    let depth = 0;
    while (queue.length > 0) {
      const nextLevel: string[] = [];
      for (const node of queue) {
        for (const n of adj.get(node) ?? []) {
          if (visited.has(n)) continue;
          visited.add(n);
          reachable.add(n);
          if (expr.quantifier !== "1") nextLevel.push(n);
        }
      }
      queue.length = 0;
      queue.push(...nextLevel);
      depth++;
      if (expr.quantifier === "1" && depth >= 1) break;
    }
    for (const target of reachable) {
      let current = unify(expr.from, start, env, ctx);
      if (!current) continue;
      const next = unify(expr.to, target, current, ctx);
      if (!next) continue;
      yield next;
    }
  }
}

// ──────── like() pattern matching ────────

function likeMatch(value: string, pattern: string): boolean {
  // Convert SQL-like wildcards to regex: % → .*, _ → .
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^" + escaped.replace(/%/g, ".*").replace(/_/g, ".") + "$");
  return re.test(value);
}

// ──────── Top-level query API ────────

export interface QueryResult {
  rows: Binding[];
  count: number;
}

export function runQuery(query: Query, ctx: QueryContext): QueryResult {
  const projected: Binding[] = [];
  const seen = new Set<string>();
  for (const env of evaluate(query.body, ctx, {})) {
    const row: Record<string, unknown> = {};
    if (query.head.length === 0) {
      // Yes/no: return one empty row indicating success.
      const key = "_";
      if (!seen.has(key)) {
        seen.add(key);
        projected.push({});
      }
      // Don't break — it's fine to short-circuit at the caller.
      break;
    }
    for (const name of query.head) {
      if (Object.prototype.hasOwnProperty.call(env, name)) {
        row[name] = env[name];
      }
    }
    const key = bindingKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    projected.push(row);
  }
  return { rows: projected, count: projected.length };
}

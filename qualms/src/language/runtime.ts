import type {
  Block,
  BodyStatement,
  CallableStatement,
  Expression,
  ParameterPattern,
  RelationAtom,
  RuleStatement,
  SetStatement,
  Term,
  TypeExpr,
  ValidationAssertion,
  WhenStatement,
} from "./ast.js";
import {
  type Effect,
  type Fact,
  type GroundTerm,
  StoryModel,
  factFromAtom,
  groundTermFromTerm,
  termKey,
} from "./model.js";
import { parseRelationAtom } from "./parser.js";

type Env = Record<string, GroundTerm>;

export interface LanguagePlayResult {
  readonly status: "passed" | "failed";
  readonly feedback: string;
  readonly reasons: readonly string[];
  readonly effects: readonly Effect[];
  readonly events: readonly LanguageEvent[];
  readonly failures: readonly LanguageFailure[];
}

export interface LanguageEvent {
  readonly event: string;
  readonly args: readonly GroundTerm[];
}

export interface LanguageFailure {
  readonly kind: "unknown_action" | "action_failed" | "condition" | "terminal";
  readonly message: string;
  readonly callable?: string;
}

export interface LanguageHostPredicateCall {
  readonly predicate: string;
  readonly args: readonly GroundTerm[];
}

export interface LanguageHostAdapter {
  readonly evalPredicate: (call: LanguageHostPredicateCall) => boolean;
}

export interface LanguageRuntimeOptions {
  readonly host?: LanguageHostAdapter;
}

export interface LanguageValidationFailure {
  readonly validation: string;
  readonly assertion: number;
  readonly message: string;
}

export interface LanguageValidationResult {
  readonly status: "passed" | "failed";
  readonly failures: readonly LanguageValidationFailure[];
}

interface BlockResult {
  readonly status: "passed" | "failed" | "no_match";
  readonly env: Env;
  readonly reasons: readonly string[];
  readonly terminal?: "succeed" | "fail";
  readonly callable?: string;
}

export function playLanguageCall(
  model: StoryModel,
  call: string | RelationAtom,
  options: LanguageRuntimeOptions = {},
): LanguagePlayResult {
  const atom = typeof call === "string" ? parseRelationAtom(call) : call;
  const callable = model.actions.get(atom.relation);
  if (!callable) {
    return failResult([`!${emitRelationAtom(atom, {})}`], [], [], {
      kind: "unknown_action",
      callable: atom.relation,
    });
  }

  const args = atom.args.map(groundTermFromTerm);
  const working = model.clone();
  const effects: Effect[] = [];
  const events: LanguageEvent[] = [];
  const result = executeCallable(working, callable, args, "action", effects, events, options);
  if (result.status !== "passed") {
    return failResult(result.reasons, [], [], {
      kind: "action_failed",
      callable: atom.relation,
    });
  }

  commitEffects(model, effects);
  return { status: "passed", feedback: "succeed;", reasons: [], effects, events, failures: [] };
}

export function evalLanguageAtom(
  model: StoryModel,
  call: string | RelationAtom,
  options: LanguageRuntimeOptions = {},
): LanguagePlayResult {
  const atom = typeof call === "string" ? parseRelationAtom(call) : call;
  if (model.actions.has(atom.relation)) return playLanguageCall(model, atom);

  const expression: Expression = { kind: "relation", atom };
  const effects: Effect[] = [];
  const matches = evalExpression(model, expression, {}, effects, [], options);
  if (matches.length > 0) {
    return { status: "passed", feedback: "succeed;", reasons: [], effects, events: [], failures: [] };
  }
  return failResult(explainExpression(model, expression, {}), effects, [], {
    kind: "condition",
  });
}

export function runLanguageValidations(
  model: StoryModel,
  options: LanguageRuntimeOptions = {},
): LanguageValidationResult {
  const failures: LanguageValidationFailure[] = [];
  for (const validation of model.validations.values()) {
    validation.assertions.forEach((assertion, index) => {
      const message = evaluateValidationAssertion(model, assertion, options);
      if (!message) return;
      failures.push({ validation: validation.id, assertion: index + 1, message });
    });
  }
  return failures.length === 0 ? { status: "passed", failures: [] } : { status: "failed", failures };
}

function evaluateValidationAssertion(
  model: StoryModel,
  assertion: ValidationAssertion,
  options: LanguageRuntimeOptions,
): string | undefined {
  switch (assertion.kind) {
    case "fact": {
      const fact = factFromAtom(assertion.atom);
      const matched = model.hasFact(fact.relation, fact.args);
      if (assertion.negate ? !matched : matched) return undefined;
      return assertion.negate
        ? `expected fact to be absent: ${emitRelationAtom(assertion.atom, {})}`
        : `expected fact: ${emitRelationAtom(assertion.atom, {})}`;
    }
    case "query": {
      const matches = evalExpression(model, assertion.expression, {}, [], [], options);
      const matched = assertion.expectedBindings
        ? matches.length === 1 && assertion.expectedBindings.every((binding) => evalExpression(model, binding, matches[0]!, [], [], options).length > 0)
        : matches.length > 0;
      if (assertion.negate ? !matched : matched) return undefined;
      if (assertion.expectedBindings) {
        return `expected query bindings: ${emitExpression(assertion.expression, {})}`;
      }
      return assertion.negate
        ? `expected query to have no matches: ${emitExpression(assertion.expression, {})}`
        : `expected query to match: ${emitExpression(assertion.expression, {})}`;
    }
    case "play": {
      const result = playLanguageCall(model.clone(), assertion.atom, options);
      if (result.status !== assertion.expected) {
        return `expected play ${emitRelationAtom(assertion.atom, {})} to ${assertion.expected}, got ${result.status}`;
      }
      if (assertion.expectedEffects) {
        const expected = assertion.expectedEffects.map((effect) => ({
          polarity: effect.polarity,
          fact: factFromAtom(effect.atom),
        }));
        if (!sameEffects(result.effects, expected)) {
          return `expected play ${emitRelationAtom(assertion.atom, {})} effects to match`;
        }
      }
      if (assertion.expectedReasons) {
        const expectedReasons = assertion.expectedReasons.map((reason) => emitExpression(reason, {}));
        const missing = expectedReasons.filter((reason) => !result.reasons.includes(reason));
        if (missing.length > 0) {
          return `expected play ${emitRelationAtom(assertion.atom, {})} reasons to include ${missing.join(", ")}`;
        }
      }
      return undefined;
    }
  }
}

function sameEffects(left: readonly Effect[], right: readonly Effect[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((effect, index) => {
    const other = right[index]!;
    return effect.polarity === other.polarity && factKeyForRuntime(effect.fact) === factKeyForRuntime(other.fact);
  });
}

function factKeyForRuntime(fact: Fact): string {
  return `${fact.relation}|${JSON.stringify(fact.args)}`;
}

function executeCallable(
  model: StoryModel,
  callable: CallableStatement,
  args: readonly GroundTerm[],
  mode: "action" | "predicate",
  effects: Effect[],
  events: LanguageEvent[],
  options: LanguageRuntimeOptions,
): BlockResult {
  const bound = bindParameters(model, callable.parameters, args, effects, events, options);
  if (bound.length === 0) {
    return {
      status: "failed",
      env: {},
      reasons: [`!${callable.id}(${args.map(emitGroundTerm).join(", ")})`],
      callable: callable.id,
    };
  }

  for (const env of bound) {
    // Parameter scopes are fresh: rules attached to this callable do not
    // inherit names from the caller's env, and after-rules do not inherit
    // names from the body's env. Rule parameter constraints re-introduce
    // any names they need.
    const before = runRules(model, "before", callable.id, args, effects, events, options);
    if (before.status === "failed" && before.terminal === "fail") return before;
    if (before.status === "passed" && before.terminal === "succeed") return before;

    const body = executeBlock(model, callable.body, env, effects, events, options);
    if (body.status !== "passed") {
      if (before.reasons.length > 0) {
        return { ...body, reasons: [...body.reasons, ...before.reasons] };
      }
      return body;
    }

    if (mode === "action") {
      const after = runRules(model, "after", callable.id, args, effects, events, options);
      if (after.status === "failed" && after.terminal === "fail") return after;
    }
    return body;
  }

  return {
    status: "failed",
    env: {},
    reasons: [`!${callable.id}(${args.map(emitGroundTerm).join(", ")})`],
    callable: callable.id,
  };
}

function runRules(
  model: StoryModel,
  phase: "before" | "after",
  target: string,
  args: readonly GroundTerm[],
  effects: Effect[],
  events: LanguageEvent[],
  options: LanguageRuntimeOptions,
): BlockResult {
  const noMatchReasons: string[] = [];
  for (const rule of model.rules) {
    if (rule.phase !== phase || rule.target !== target) continue;
    const bound = bindParameters(model, rule.parameters, args, effects, events, options);
    for (const ruleEnv of bound) {
      const outcome = executeRuleBlock(model, rule, ruleEnv, effects, events, options);
      if (outcome.status === "failed" && outcome.terminal === "fail") return outcome;
      if (outcome.status === "passed" && outcome.terminal === "succeed") return outcome;
      // Surface only would-have-rescued reasons: a succeed-rule whose when
      // failed contributes useful failure context. A fail-rule whose when
      // failed is a non-event (the rule wasn't meant to fire) and would be
      // noise.
      if (outcome.status === "failed" && blockHasSucceed(rule.body)) {
        noMatchReasons.push(...outcome.reasons);
      }
    }
  }
  return { status: "no_match", env: {}, reasons: noMatchReasons };
}

function blockHasSucceed(block: Block): boolean {
  for (const statement of block.statements) {
    if (statement.kind === "succeed") return true;
    if (statement.kind === "when" && blockHasSucceed(statement.body)) return true;
  }
  return false;
}

function executeRuleBlock(
  model: StoryModel,
  _rule: RuleStatement,
  env: Env,
  effects: Effect[],
  events: LanguageEvent[],
  options: LanguageRuntimeOptions,
): BlockResult {
  return executeBlock(model, _rule.body, env, effects, events, options);
}

function bindParameters(
  model: StoryModel,
  patterns: readonly ParameterPattern[],
  args: readonly GroundTerm[],
  effects: Effect[],
  events: LanguageEvent[],
  options: LanguageRuntimeOptions,
): Env[] {
  if (patterns.length !== args.length) return [];
  let envs: Env[] = [{}];
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i]!;
    const arg = args[i]!;
    const next: Env[] = [];
    for (const env of envs) {
      if (pattern.type && !matchesType(model, arg, pattern.type)) continue;
      const named = pattern.name ? bindName(pattern.name, arg, env) : env;
      if (!named) continue;
      let constrained = [named];
      for (const constraint of pattern.constraints) {
        constrained = constrained.flatMap((candidate) => evalExpression(model, constraint, candidate, effects, events, options));
      }
      next.push(...constrained);
    }
    envs = next;
  }
  return envs;
}

function executeBlock(
  model: StoryModel,
  block: Block,
  env: Env,
  effects: Effect[],
  events: LanguageEvent[],
  options: LanguageRuntimeOptions,
): BlockResult {
  let current = env;
  const reasons: string[] = [];
  for (const statement of block.statements) {
    const result = executeBodyStatement(model, statement, current, effects, events, options);
    if (result.status === "no_match") {
      reasons.push(...result.reasons);
      continue;
    }
    if (result.status === "failed") return result;
    if (result.terminal) return result;
    current = result.env;
  }
  if (reasons.length > 0) return { status: "failed", env: current, reasons };
  return { status: "passed", env: current, reasons: [] };
}

function executeBodyStatement(
  model: StoryModel,
  statement: BodyStatement,
  env: Env,
  effects: Effect[],
  events: LanguageEvent[],
  options: LanguageRuntimeOptions,
): BlockResult {
  switch (statement.kind) {
    case "when":
      return executeWhen(model, statement, env, effects, events, options);
    case "set":
      applySet(model, statement, env, effects);
      return { status: "passed", env, reasons: [] };
    case "emit":
      applyEmit(statement.atom, env, events);
      return { status: "passed", env, reasons: [] };
    case "succeed":
      return { status: "passed", env, reasons: [], terminal: "succeed" };
    case "fail":
      return { status: "failed", env, reasons: ["fail"], terminal: "fail" };
  }
}

function executeWhen(
  model: StoryModel,
  statement: WhenStatement,
  env: Env,
  effects: Effect[],
  events: LanguageEvent[],
  options: LanguageRuntimeOptions,
): BlockResult {
  const matches = evalExpression(model, statement.condition, env, effects, events, options);
  if (matches.length === 0) {
    return { status: "no_match", env, reasons: explainExpression(model, statement.condition, env) };
  }
  for (const match of matches) {
    const body = executeBlock(model, statement.body, match, effects, events, options);
    if (body.status === "passed" && body.terminal === "succeed") return body;
    if (body.status === "failed" && body.terminal === "fail") {
      return {
        ...body,
        reasons: explainPositiveCondition(statement.condition, match),
      };
    }
    if (body.status === "passed") return body;
  }
  return { status: "failed", env, reasons: explainExpression(model, statement.condition, env) };
}

function applySet(model: StoryModel, statement: SetStatement, env: Env, effects: Effect[]): void {
  for (const setEffect of statement.effects) {
    const atom = groundAtom(setEffect.atom, env);
    const fact = factFromAtom(atom);
    if (setEffect.polarity === "assert") model.assertFact(fact);
    else model.retractFact(fact);
    effects.push({ polarity: setEffect.polarity, fact });
  }
}

function applyEmit(atom: RelationAtom, env: Env, events: LanguageEvent[]): void {
  const grounded = groundAtom(atom, env);
  events.push({ event: grounded.relation, args: grounded.args.map(groundTermFromTerm) });
}

function commitEffects(model: StoryModel, effects: readonly Effect[]): void {
  for (const effect of effects) {
    if (effect.polarity === "assert") model.assertFact(effect.fact);
    else model.retractFact(effect.fact);
  }
}

function evalExpression(
  model: StoryModel,
  expression: Expression,
  env: Env,
  effects: Effect[],
  events: LanguageEvent[],
  options: LanguageRuntimeOptions,
): Env[] {
  switch (expression.kind) {
    case "relation":
      return evalRelation(model, expression.atom, env, effects, events, options);
    case "not":
      return evalExpression(model, expression.operand, env, effects, events, options).length === 0 ? [env] : [];
    case "binary": {
      if (expression.op === "&") {
        return evalExpression(model, expression.left, env, effects, events, options).flatMap((leftEnv) =>
          evalExpression(model, expression.right, leftEnv, effects, events, options),
        );
      }
      return dedupeEnvs([
        ...evalExpression(model, expression.left, env, effects, events, options),
        ...evalExpression(model, expression.right, env, effects, events, options),
      ]);
    }
    case "equal": {
      const left = resolveTerm(expression.left, env);
      const right = resolveTerm(expression.right, env);
      if (left && right) return termKey(left) === termKey(right) ? [env] : [];
      if (!left && right && expression.left.kind === "variable") {
        const bound = bindName(expression.left.id, right, env);
        return bound ? [bound] : [];
      }
      if (!right && left && expression.right.kind === "variable") {
        const bound = bindName(expression.right.id, left, env);
        return bound ? [bound] : [];
      }
      return [];
    }
  }
}

function evalRelation(
  model: StoryModel,
  atom: RelationAtom,
  env: Env,
  effects: Effect[],
  events: LanguageEvent[],
  options: LanguageRuntimeOptions,
): Env[] {
  const externalPredicate = model.externalPredicates.get(atom.relation);
  if (externalPredicate) {
    const args = atom.args.map((term) => resolveTerm(term, env));
    if (args.some((arg) => arg === undefined)) return [];
    return options.host?.evalPredicate({ predicate: atom.relation, args: args as GroundTerm[] }) ? [env] : [];
  }

  const predicate = model.predicates.get(atom.relation);
  if (predicate) {
    const args = atom.args.map((term) => resolveTerm(term, env));
    if (args.some((arg) => arg === undefined)) return [];
    const result = executeCallable(model, predicate, args as GroundTerm[], "predicate", effects, events, options);
    // Predicate parameter names live in the predicate's own scope; the
    // caller continues with the env it had before the call.
    return result.status === "passed" ? [env] : [];
  }

  const out: Env[] = [];
  for (const fact of model.listFacts(atom.relation)) {
    const matched = matchAtom(atom, fact, env);
    if (matched) out.push(matched);
  }
  return dedupeEnvs(out);
}

function matchAtom(atom: RelationAtom, fact: Fact, env: Env): Env | undefined {
  if (atom.args.length !== fact.args.length) return undefined;
  let current = env;
  for (let i = 0; i < atom.args.length; i++) {
    const next = matchTerm(atom.args[i]!, fact.args[i]!, current);
    if (!next) return undefined;
    current = next;
  }
  return current;
}

function matchTerm(pattern: Term, value: GroundTerm, env: Env): Env | undefined {
  switch (pattern.kind) {
    case "wildcard":
      return env;
    case "identifier":
      return matchIdentifier(pattern.id, value, env);
    case "variable":
      return bindName(pattern.id, value, env);
    case "string":
      return value.kind === "string" && value.value === pattern.value ? env : undefined;
    case "number":
      return value.kind === "number" && value.value === pattern.value ? env : undefined;
    case "relationInstance": {
      if (value.kind !== "relation" || value.relation !== pattern.atom.relation) return undefined;
      if (value.args.length !== pattern.atom.args.length) return undefined;
      let current = env;
      for (let i = 0; i < pattern.atom.args.length; i++) {
        const next = matchTerm(pattern.atom.args[i]!, value.args[i]!, current);
        if (!next) return undefined;
        current = next;
      }
      return current;
    }
  }
}

function bindName(name: string, value: GroundTerm, env: Env): Env | undefined {
  const existing = env[name];
  if (existing) return termKey(existing) === termKey(value) ? env : undefined;
  return { ...env, [name]: value };
}

function matchIdentifier(name: string, value: GroundTerm, env: Env): Env | undefined {
  const existing = env[name];
  if (existing) return termKey(existing) === termKey(value) ? env : undefined;
  return value.kind === "id" && value.id === name ? env : undefined;
}

function resolveTerm(term: Term, env: Env): GroundTerm | undefined {
  switch (term.kind) {
    case "identifier":
      return env[term.id] ?? { kind: "id", id: term.id };
    case "variable":
      return env[term.id];
    case "wildcard":
      return undefined;
    case "string":
      return { kind: "string", value: term.value };
    case "number":
      return { kind: "number", value: term.value };
    case "relationInstance": {
      const args = term.atom.args.map((arg) => resolveTerm(arg, env));
      if (args.some((arg) => arg === undefined)) return undefined;
      return { kind: "relation", relation: term.atom.relation, args: args as GroundTerm[] };
    }
  }
}

function groundAtom(atom: RelationAtom, env: Env): RelationAtom {
  return {
    relation: atom.relation,
    args: atom.args.map((term) => {
      const resolved = resolveTerm(term, env);
      if (!resolved) throw new Error(`cannot ground '${emitTerm(term, env)}'`);
      return termFromGround(resolved);
    }),
  };
}

function termFromGround(term: GroundTerm): Term {
  switch (term.kind) {
    case "id":
      return { kind: "identifier", id: term.id };
    case "string":
      return { kind: "string", value: term.value };
    case "number":
      return { kind: "number", value: term.value };
    case "relation":
      return {
        kind: "relationInstance",
        atom: { relation: term.relation, args: term.args.map(termFromGround) },
      };
  }
}

function matchesType(model: StoryModel, value: GroundTerm, type: TypeExpr): boolean {
  if (type.kind === "intersection") {
    return type.types.every((inner) => matchesType(model, value, inner));
  }
  if (type.id === "Any") return true;
  if (model.traits.has(type.id)) {
    return value.kind === "id" && model.entities.get(value.id)?.has(type.id) === true;
  }
  if (model.relations.has(type.id)) {
    return value.kind === "relation" && value.relation === type.id;
  }
  if (model.entities.has(type.id)) {
    // Entity-literal slot: parameter only binds when the arg is this entity.
    return value.kind === "id" && value.id === type.id;
  }
  return false;
}

function explainExpression(model: StoryModel, expression: Expression, env: Env): string[] {
  // Diagnostic re-evaluation: effects from this path are not surfaced because
  // the action has already failed — counting them would double-report any
  // mutating predicates that ran during the original evaluation.
  const discard: Effect[] = [];
  switch (expression.kind) {
    case "relation": {
      const predicate = model.predicates.get(expression.atom.relation);
      if (predicate) {
        const args = expression.atom.args.map((term) => resolveTerm(term, env));
        if (args.every((arg) => arg !== undefined)) {
          const result = executeCallable(model, predicate, args as GroundTerm[], "predicate", discard, [], {});
          if (result.status === "failed" && result.reasons.length > 0) {
            return [...result.reasons];
          }
        }
      }
      return [`!${emitRelationAtom(expression.atom, env)}`];
    }
    case "not":
      return [emitExpression(expression, env)];
    case "binary":
      if (expression.op === "|") {
        return [
          ...explainExpression(model, expression.left, env),
          ...explainExpression(model, expression.right, env),
        ];
      }
      if (evalExpression(model, expression.left, env, discard, [], {}).length === 0) {
        return explainExpression(model, expression.left, env);
      }
      return evalExpression(model, expression.left, env, discard, [], {}).flatMap((leftEnv) =>
        explainExpression(model, expression.right, leftEnv),
      );
    case "equal":
      return [`!${emitExpression(expression, env)}`];
  }
}

function explainPositiveCondition(expression: Expression, env: Env): string[] {
  return [emitExpression(expression, env)];
}

function failResult(
  reasons: readonly string[],
  effects: readonly Effect[],
  events: readonly LanguageEvent[],
  options: { readonly kind: LanguageFailure["kind"]; readonly callable?: string } = { kind: "condition" },
): LanguagePlayResult {
  const unique = [...new Set(reasons.filter((reason) => reason !== "fail"))];
  const body = unique.length > 0 ? ` ${unique.map((reason) => `${reason};`).join(" ")} ` : " ";
  const failures = unique.length > 0
    ? unique.map((message) => ({ kind: options.kind, message, ...(options.callable ? { callable: options.callable } : {}) }))
    : [{ kind: options.kind, message: "fail", ...(options.callable ? { callable: options.callable } : {}) }];
  return { status: "failed", feedback: `fail {${body}}`, reasons: unique, effects, events, failures };
}

function dedupeEnvs(envs: Env[]): Env[] {
  const seen = new Set<string>();
  const out: Env[] = [];
  for (const env of envs) {
    const key = JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(env);
  }
  return out;
}

function emitExpression(expression: Expression, env: Env): string {
  switch (expression.kind) {
    case "relation":
      return emitRelationAtom(expression.atom, env);
    case "not":
      return `!${emitExpression(expression.operand, env)}`;
    case "binary":
      return `${emitExpression(expression.left, env)} ${expression.op} ${emitExpression(expression.right, env)}`;
    case "equal":
      return `${emitTerm(expression.left, env)} == ${emitTerm(expression.right, env)}`;
  }
}

function emitRelationAtom(atom: RelationAtom, env: Env): string {
  return `${atom.relation}(${atom.args.map((arg) => emitTerm(arg, env)).join(", ")})`;
}

function emitTerm(term: Term, env: Env): string {
  if (term.kind === "variable" && !env[term.id]) return `?${term.id}`;
  const resolved = resolveTerm(term, env);
  return resolved ? emitGroundTerm(resolved) : "_";
}

function emitGroundTerm(term: GroundTerm): string {
  switch (term.kind) {
    case "id":
      return term.id;
    case "string":
      return JSON.stringify(term.value);
    case "number":
      return String(term.value);
    case "relation":
      return `${term.relation}(${term.args.map(emitGroundTerm).join(", ")})`;
  }
}

export const languageRuntimeInternals = {
  evalExpression: (model: StoryModel, expression: Expression, env: Env): Env[] =>
    evalExpression(model, expression, env, [], [], {}),
};

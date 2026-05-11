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
}

interface BlockResult {
  readonly status: "passed" | "failed" | "no_match";
  readonly env: Env;
  readonly reasons: readonly string[];
  readonly terminal?: "succeed" | "fail";
}

export function playLanguageCall(model: StoryModel, call: string | RelationAtom): LanguagePlayResult {
  const atom = typeof call === "string" ? parseRelationAtom(call) : call;
  const callable = model.actions.get(atom.relation);
  if (!callable) return failResult([`!${emitRelationAtom(atom, {})}`], []);

  const args = atom.args.map(groundTermFromTerm);
  const effects: Effect[] = [];
  const result = executeCallable(model, callable, args, "action", {}, effects);
  return result.status === "passed"
    ? { status: "passed", feedback: "succeed;", reasons: [], effects }
    : failResult(result.reasons, effects);
}

export function evalLanguageAtom(model: StoryModel, call: string | RelationAtom): LanguagePlayResult {
  const atom = typeof call === "string" ? parseRelationAtom(call) : call;
  if (model.actions.has(atom.relation)) return playLanguageCall(model, atom);

  const expression: Expression = { kind: "relation", atom };
  const effects: Effect[] = [];
  const matches = evalExpression(model, expression, {}, effects);
  if (matches.length > 0) {
    return { status: "passed", feedback: "succeed;", reasons: [], effects };
  }
  return failResult(explainExpression(model, expression, {}), effects);
}

function executeCallable(
  model: StoryModel,
  callable: CallableStatement,
  args: readonly GroundTerm[],
  mode: "action" | "predicate",
  baseEnv: Env,
  effects: Effect[],
): BlockResult {
  const bound = bindParameters(model, callable.parameters, args, baseEnv, effects);
  if (bound.length === 0) {
    return {
      status: "failed",
      env: baseEnv,
      reasons: [`!${callable.id}(${args.map(emitGroundTerm).join(", ")})`],
    };
  }

  for (const env of bound) {
    // Before-rules see only the caller-supplied baseEnv, not the action's
    // parameter-bound env. The action's parameter names are internal to the
    // body; rules re-bind the original positional args against their own
    // patterns and must not inherit names from a sibling pattern shape.
    const before = runRules(model, "before", callable.id, args, baseEnv, effects);
    if (before.status === "failed" && before.terminal === "fail") return before;
    if (before.status === "passed" && before.terminal === "succeed") return before;

    const body = executeBlock(model, callable.body, env, effects);
    if (body.status !== "passed") {
      if (before.reasons.length > 0) {
        return { ...body, reasons: [...body.reasons, ...before.reasons] };
      }
      return body;
    }

    if (mode === "action") {
      const after = runRules(model, "after", callable.id, args, body.env, effects);
      if (after.status === "failed" && after.terminal === "fail") return after;
    }
    return body;
  }

  return {
    status: "failed",
    env: baseEnv,
    reasons: [`!${callable.id}(${args.map(emitGroundTerm).join(", ")})`],
  };
}

function runRules(
  model: StoryModel,
  phase: "before" | "after",
  target: string,
  args: readonly GroundTerm[],
  env: Env,
  effects: Effect[],
): BlockResult {
  const noMatchReasons: string[] = [];
  for (const rule of model.rules) {
    if (rule.phase !== phase || rule.target !== target) continue;
    const bound = bindParameters(model, rule.parameters, args, env, effects);
    for (const ruleEnv of bound) {
      const outcome = executeRuleBlock(model, rule, ruleEnv, effects);
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
  return { status: "no_match", env, reasons: noMatchReasons };
}

function blockHasSucceed(block: Block): boolean {
  for (const statement of block.statements) {
    if (statement.kind === "succeed") return true;
    if (statement.kind === "when" && blockHasSucceed(statement.body)) return true;
  }
  return false;
}

function executeRuleBlock(model: StoryModel, _rule: RuleStatement, env: Env, effects: Effect[]): BlockResult {
  return executeBlock(model, _rule.body, env, effects);
}

function bindParameters(
  model: StoryModel,
  patterns: readonly ParameterPattern[],
  args: readonly GroundTerm[],
  baseEnv: Env,
  effects: Effect[],
): Env[] {
  if (patterns.length !== args.length) return [];
  let envs: Env[] = [{ ...baseEnv }];
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
        constrained = constrained.flatMap((candidate) => evalExpression(model, constraint, candidate, effects));
      }
      next.push(...constrained);
    }
    envs = next;
  }
  return envs;
}

function executeBlock(model: StoryModel, block: Block, env: Env, effects: Effect[]): BlockResult {
  let current = env;
  const reasons: string[] = [];
  for (const statement of block.statements) {
    const result = executeBodyStatement(model, statement, current, effects);
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

function executeBodyStatement(model: StoryModel, statement: BodyStatement, env: Env, effects: Effect[]): BlockResult {
  switch (statement.kind) {
    case "when":
      return executeWhen(model, statement, env, effects);
    case "set":
      applySet(model, statement, env, effects);
      return { status: "passed", env, reasons: [] };
    case "succeed":
      return { status: "passed", env, reasons: [], terminal: "succeed" };
    case "fail":
      return { status: "failed", env, reasons: ["fail"], terminal: "fail" };
  }
}

function executeWhen(model: StoryModel, statement: WhenStatement, env: Env, effects: Effect[]): BlockResult {
  const matches = evalExpression(model, statement.condition, env, effects);
  if (matches.length === 0) {
    return { status: "no_match", env, reasons: explainExpression(model, statement.condition, env) };
  }
  for (const match of matches) {
    const body = executeBlock(model, statement.body, match, effects);
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

function evalExpression(model: StoryModel, expression: Expression, env: Env, effects: Effect[]): Env[] {
  switch (expression.kind) {
    case "relation":
      return evalRelation(model, expression.atom, env, effects);
    case "not":
      return evalExpression(model, expression.operand, env, effects).length === 0 ? [env] : [];
    case "binary": {
      if (expression.op === "&") {
        return evalExpression(model, expression.left, env, effects).flatMap((leftEnv) =>
          evalExpression(model, expression.right, leftEnv, effects),
        );
      }
      return dedupeEnvs([
        ...evalExpression(model, expression.left, env, effects),
        ...evalExpression(model, expression.right, env, effects),
      ]);
    }
    case "equal": {
      const left = resolveTerm(expression.left, env);
      const right = resolveTerm(expression.right, env);
      if (left && right) return termKey(left) === termKey(right) ? [env] : [];
      if (!left && right && expression.left.kind === "identifier") {
        const bound = bindName(expression.left.id, right, env);
        return bound ? [bound] : [];
      }
      if (!right && left && expression.right.kind === "identifier") {
        const bound = bindName(expression.right.id, left, env);
        return bound ? [bound] : [];
      }
      return [];
    }
  }
}

function evalRelation(model: StoryModel, atom: RelationAtom, env: Env, effects: Effect[]): Env[] {
  const predicate = model.predicates.get(atom.relation);
  if (predicate) {
    const args = atom.args.map((term) => resolveTerm(term, env));
    if (args.some((arg) => arg === undefined)) return [];
    const result = executeCallable(model, predicate, args as GroundTerm[], "predicate", env, effects);
    return result.status === "passed" ? [result.env] : [];
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

function resolveTerm(term: Term, env: Env): GroundTerm | undefined {
  switch (term.kind) {
    case "identifier":
      return env[term.id] ?? { kind: "id", id: term.id };
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
          const result = executeCallable(model, predicate, args as GroundTerm[], "predicate", env, discard);
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
      if (evalExpression(model, expression.left, env, discard).length === 0) {
        return explainExpression(model, expression.left, env);
      }
      return evalExpression(model, expression.left, env, discard).flatMap((leftEnv) =>
        explainExpression(model, expression.right, leftEnv),
      );
    case "equal":
      return [`!${emitExpression(expression, env)}`];
  }
}

function explainPositiveCondition(expression: Expression, env: Env): string[] {
  return [emitExpression(expression, env)];
}

function failResult(reasons: readonly string[], effects: readonly Effect[]): LanguagePlayResult {
  const unique = [...new Set(reasons.filter((reason) => reason !== "fail"))];
  const body = unique.length > 0 ? ` ${unique.map((reason) => `${reason};`).join(" ")} ` : " ";
  return { status: "failed", feedback: `fail {${body}}`, reasons: unique, effects };
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
    evalExpression(model, expression, env, []),
};

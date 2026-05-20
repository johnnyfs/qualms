import { writeFileSync } from "node:fs";
import { language as languageNs } from "@quealm/qualms";
import type { SessionManager } from "./session.js";

type GroundTerm = languageNs.GroundTerm;
type Expression = languageNs.Expression;
type RelationAtom = languageNs.RelationAtom;
type Env = Record<string, GroundTerm>;

export class QueryError extends Error {
  constructor(
    message: string,
    public readonly category: "parse" | "evaluate",
  ) {
    super(message);
    this.name = "QueryError";
  }
}

export class MutationError extends Error {
  constructor(
    message: string,
    public readonly category: "parse" | "scope_error",
  ) {
    super(message);
    this.name = "MutationError";
  }
}

export class PlayError extends Error {
  constructor(
    message: string,
    public readonly category: "parse" | "missing_arg",
  ) {
    super(message);
    this.name = "PlayError";
  }
}

export interface StartInput {
  storyPaths?: string[];
}

export interface StartOutput {
  sessionId: string;
  loaded: {
    storyPaths: string[];
    counts: ModelCounts;
  };
}

export interface ModelCounts {
  traits: number;
  relations: number;
  predicates: number;
  externalPredicates: number;
  actions: number;
  rules: number;
  validations: number;
  entities: number;
  facts: number;
}

export function handleStart(manager: SessionManager, input: StartInput = {}): StartOutput {
  const session = manager.start({ storyPaths: input.storyPaths ?? [] });
  return {
    sessionId: session.id,
    loaded: {
      storyPaths: [...session.storyPaths],
      counts: countModel(session.model),
    },
  };
}

export interface QuitInput {
  sessionId: string;
}

export interface QuitOutput {
  ok: boolean;
}

export function handleQuit(manager: SessionManager, input: QuitInput): QuitOutput {
  return { ok: manager.quit(input.sessionId) };
}

export interface QueryInput {
  sessionId: string;
  expr?: string;
}

export type QueryOutput =
  | {
      kind: "summary";
      counts: ModelCounts;
      facts: FactRecord[];
    }
  | {
      kind: "query";
      expr: string;
      rows: Array<Record<string, unknown>>;
      count: number;
      text: string;
    }
  | {
      kind: "show";
      targetKind: string;
      name?: string;
      definitions: string[];
      count: number;
      text: string;
    };

export interface FactRecord {
  relation: string;
  args: unknown[];
  text: string;
}

export function handleQuery(manager: SessionManager, input: QueryInput): QueryOutput {
  const session = manager.get(input.sessionId);
  const expr = input.expr?.trim();
  if (!expr || expr === "facts") {
    return {
      kind: "summary",
      counts: countModel(session.model),
      facts: session.model.listFacts().map(formatFact),
    };
  }

  const show = parseShow(expr);
  if (show) {
    const definitions = showDefinitions(session.model, show.targetKind, show.name);
    return {
      kind: "show",
      targetKind: show.targetKind,
      ...(show.name ? { name: show.name } : {}),
      definitions,
      count: definitions.length,
      text: definitions.join("\n\n"),
    };
  }

  let parsed: Expression;
  try {
    parsed = languageNs.parseExpression(expr);
  } catch (err) {
    throw new QueryError(errorMessage(err), "parse");
  }

  try {
    if (parsed.kind === "relation" && session.model.queries.has(parsed.atom.relation)) {
      const result = languageNs.playLanguageQuery(session.model, parsed.atom);
      if (result.status !== "passed") {
        throw new QueryError(
          result.failures[0]?.message ?? `query '${parsed.atom.relation}' failed`,
          "evaluate",
        );
      }
      const rows = result.bindings.map((env) => formatRow(env));
      return {
        kind: "query",
        expr,
        rows,
        count: rows.length,
        text: renderNamedQueryRows(rows, parsed.atom),
      };
    }

    const rows = languageNs.languageRuntimeInternals
      .evalExpression(session.model, parsed, {})
      .map((env) => formatRow(env));
    return {
      kind: "query",
      expr,
      rows,
      count: rows.length,
      text: renderRows(rows, parsed, expr),
    };
  } catch (err) {
    if (err instanceof QueryError) throw err;
    throw new QueryError(errorMessage(err), "evaluate");
  }
}

export interface BeginInput {
  sessionId: string;
  targetPath?: string;
}

export interface BeginOutput {
  transactionId: string;
  targetPath?: string;
}

export function handleBegin(manager: SessionManager, input: BeginInput): BeginOutput {
  const transaction = manager.beginTransaction(input.sessionId, input.targetPath);
  return {
    transactionId: transaction.id,
    ...(transaction.targetPath ? { targetPath: transaction.targetPath } : {}),
  };
}

export interface MutateInput {
  sessionId: string;
  transactionId: string;
  expr: string;
}

export interface MutateOutput {
  applied: number;
  counts: ModelCounts;
}

export function handleMutate(manager: SessionManager, input: MutateInput): MutateOutput {
  try {
    manager.applyToTransaction(input.sessionId, input.transactionId, input.expr);
  } catch (err) {
    if (err instanceof languageNs.LanguageParseError) {
      throw new MutationError(err.message, "parse");
    }
    throw err;
  }
  const session = manager.get(input.sessionId);
  const transaction = session.transaction;
  return {
    applied: transaction?.applied.length ?? 0,
    counts: countModel(session.model),
  };
}

export interface DiffInput {
  sessionId: string;
  transactionId: string;
}

export interface DiffOutput {
  applied: string[];
  counts: {
    before: ModelCounts;
    after: ModelCounts;
  };
}

export function handleDiff(manager: SessionManager, input: DiffInput): DiffOutput {
  const { session, transaction } = manager.requireTransaction(
    input.sessionId,
    input.transactionId,
  );
  return {
    applied: [...transaction.applied],
    counts: {
      before: countModel(transaction.snapshot),
      after: countModel(session.model),
    },
  };
}

export interface CommitInput {
  sessionId: string;
  transactionId: string;
}

export interface CommitOutput {
  committed: number;
  persisted: boolean;
  targetPath?: string;
  reason?: string;
}

export function handleCommit(manager: SessionManager, input: CommitInput): CommitOutput {
  const { session, transaction } = manager.requireTransaction(
    input.sessionId,
    input.transactionId,
  );
  const validation = languageNs.runLanguageValidations(session.model);
  if (validation.status === "failed") {
    throw new MutationError(
      `validation failed: ${validation.failures.map((failure) => `${failure.validation}#${failure.assertion}: ${failure.message}`).join("; ")}`,
      "scope_error",
    );
  }
  if (!transaction.targetPath) {
    const result = manager.commit(input.sessionId, input.transactionId);
    return {
      committed: result.committed,
      persisted: false,
      reason: "no-target-path",
    };
  }
  writeFileSync(transaction.targetPath, languageNs.emitStoryModel(session.model), "utf-8");
  const result = manager.commit(input.sessionId, input.transactionId);
  return {
    committed: result.committed,
    persisted: true,
    targetPath: transaction.targetPath,
  };
}

export interface RollbackInput {
  sessionId: string;
  transactionId: string;
}

export interface RollbackOutput {
  discarded: number;
}

export function handleRollback(manager: SessionManager, input: RollbackInput): RollbackOutput {
  return manager.rollback(input.sessionId, input.transactionId);
}

export interface PlayInput {
  sessionId: string;
  call: string;
}

export interface PlayOutput {
  call: string;
  status: languageNs.LanguagePlayResult["status"];
  feedback: string;
  reasons: readonly string[];
  effects: languageNs.LanguagePlayResult["effects"];
  events: languageNs.LanguagePlayResult["events"];
  failures: languageNs.LanguagePlayResult["failures"];
}

export function handlePlay(manager: SessionManager, input: PlayInput): PlayOutput {
  if (!input.call) {
    throw new PlayError("play requires `call`, e.g. `Go(Player, Outside)`", "missing_arg");
  }
  try {
    const session = manager.get(input.sessionId);
    const result = languageNs.playLanguageCall(session.model, input.call);
    return { call: input.call, ...result };
  } catch (err) {
    if (err instanceof languageNs.LanguageParseError) {
      throw new PlayError(err.message, "parse");
    }
    throw err;
  }
}

function countModel(model: languageNs.StoryModel): ModelCounts {
  return {
    traits: model.traits.size,
    relations: model.relations.size,
    predicates: model.predicates.size,
    externalPredicates: model.externalPredicates.size,
    actions: model.actions.size,
    rules: model.rules.length,
    validations: model.validations.size,
    entities: model.entities.size,
    facts: model.listFacts().length,
  };
}

function parseShow(expr: string): { targetKind: string; name?: string } | undefined {
  const match = /^show(?:\s+([A-Za-z_][A-Za-z0-9_]*))?(?:\s+([A-Za-z_][A-Za-z0-9_]*))?\s*;?$/.exec(
    expr,
  );
  if (!match) return undefined;
  return {
    targetKind: match[1] ?? "all",
    ...(match[2] ? { name: match[2] } : {}),
  };
}

function showDefinitions(
  model: languageNs.StoryModel,
  targetKind: string,
  name: string | undefined,
): string[] {
  const program = languageNs.programFromModel(model);
  return program.statements
    .filter((statement) => {
      if (targetKind !== "all" && statement.kind !== targetKind) return false;
      if (!name) return true;
      return "id" in statement && statement.id === name;
    })
    .map(languageNs.emitTopLevelStatement);
}

function formatRow(env: Env): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(env)) {
    row[name] = formatGroundTerm(value);
  }
  return row;
}

function formatFact(fact: languageNs.Fact): FactRecord {
  return {
    relation: fact.relation,
    args: fact.args.map(formatGroundTerm),
    text: `${fact.relation}(${fact.args.map(formatGroundTermText).join(", ")})`,
  };
}

function formatGroundTerm(term: GroundTerm): unknown {
  switch (term.kind) {
    case "id":
      return term.id;
    case "string":
      return term.value;
    case "number":
      return term.value;
    case "relation":
      return {
        relation: term.relation,
        args: term.args.map(formatGroundTerm),
      };
  }
}

function formatGroundTermText(term: GroundTerm): string {
  switch (term.kind) {
    case "id":
      return term.id;
    case "string":
      return JSON.stringify(term.value);
    case "number":
      return String(term.value);
    case "relation":
      return `${term.relation}(${term.args.map(formatGroundTermText).join(", ")})`;
  }
}

function renderRows(
  rows: Array<Record<string, unknown>>,
  expression?: Expression,
  exprText?: string,
): string {
  if (rows.length === 0) return "[];";
  return `[${rows.map((row) => renderExpressionRow(row, expression, exprText)).join(", ")}];`;
}

function renderNamedQueryRows(rows: Array<Record<string, unknown>>, atom: RelationAtom): string {
  if (rows.length === 0) return "[];";
  const call = `${atom.relation}(${atom.args.map(formatTermText).join(", ")})`;
  return `[${rows.map((row) => `${call} -> ${renderRowFields(row)}`).join(", ")}];`;
}

function renderExpressionRow(
  row: Record<string, unknown>,
  expression: Expression | undefined,
  exprText: string | undefined,
): string {
  if (expression?.kind === "relation") {
    const fields = renderRowFields(row);
    if (fields.length > 0) return `${expression.atom.relation}(${fields})`;
    return exprText?.replace(/;$/, "") ?? `${expression.atom.relation}()`;
  }
  const fields = renderRowFields(row);
  return fields.length > 0 ? fields : "{}";
}

function renderRowFields(row: Record<string, unknown>): string {
  return Object.entries(row)
    .map(([name, value]) => `${name}=${formatPlainValueText(value)}`)
    .join(", ");
}

function formatPlainValueText(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "relation" in value &&
    "args" in value &&
    typeof (value as { relation: unknown }).relation === "string" &&
    Array.isArray((value as { args: unknown }).args)
  ) {
    const relation = (value as { relation: string }).relation;
    const args = (value as { args: unknown[] }).args;
    return `${relation}(${args.map(formatPlainValueText).join(", ")})`;
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function formatTermText(term: languageNs.Term): string {
  switch (term.kind) {
    case "identifier":
      return term.id;
    case "variable":
      return `?${term.id}`;
    case "wildcard":
      return "_";
    case "string":
      return JSON.stringify(term.value);
    case "number":
      return String(term.value);
    case "relationInstance":
      return `${term.atom.relation}(${term.atom.args.map(formatTermText).join(", ")})`;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

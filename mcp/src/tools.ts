/**
 * Tool handlers — pure functions over the SessionManager. The MCP server in
 * server.ts wraps these with the SDK's request/response plumbing; the unit
 * tests exercise them directly.
 */

import { writeFileSync } from "node:fs";
import {
  dsl as dslNs,
  mutation as mutationNs,
  play as playNs,
  query as queryNs,
  language as languageNs,
} from "@quealm/qualms";
import type { SessionManager } from "./session.js";

const { makeContext, parseQuery, parseStatement, runQuery, ParseError } = queryNs;
const { MutationError, unparseMutation } = mutationNs;
const { emitDsl } = dslNs;
const { playAction, PlayError } = playNs;

// ──────── __start ────────

export interface StartInput {
  corePath?: string;
  storyPaths?: string[];
}

export interface StartOutput {
  sessionId: string;
  loaded: {
    corePath: string;
    storyPaths: string[];
    counts: {
      traits: number;
      relations: number;
      actions: number;
      kinds: number;
      rules: number;
    };
  };
}

export function handleStart(manager: SessionManager, input: StartInput): StartOutput {
  const session = manager.start({
    ...(input.corePath ? { corePath: input.corePath } : {}),
    ...(input.storyPaths ? { storyPaths: input.storyPaths } : {}),
  });
  if (session.mode === "language") {
    return {
      sessionId: session.id,
      loaded: {
        corePath: "",
        storyPaths: [...session.storyPaths],
        counts: {
          traits: session.languageModel.traits.size,
          relations: session.languageModel.relations.size,
          actions: session.languageModel.actions.size,
          kinds: 0,
          rules: session.languageModel.rules.length,
        },
      },
    };
  }
  const def = session.definition;
  return {
    sessionId: session.id,
    loaded: {
      corePath: session.corePath,
      storyPaths: [...session.storyPaths],
      counts: {
        traits: def.traits.size,
        relations: def.relations.size,
        actions: def.actions.size,
        kinds: def.kinds.size,
        rules: def.rules.length,
      },
    },
  };
}

// ──────── __quit ────────

export interface QuitInput {
  sessionId: string;
}

export interface QuitOutput {
  ok: boolean;
}

export function handleQuit(manager: SessionManager, input: QuitInput): QuitOutput {
  return { ok: manager.quit(input.sessionId) };
}

// ──────── query (read-only DSL execution) ────────

const { parseStatements } = queryNs;

export interface QueryInput {
  sessionId: string;
  expr: string;
}

export type QueryStatementResult =
  | {
      kind: "query";
      head: string[];
      rows: Array<Record<string, unknown>>;
      count: number;
      text: string;
    }
  | { kind: "exists"; result: boolean; text: string }
  | {
      kind: "show";
      targetKind: string;
      name: string;
      definition: string;
      text: string;
    }
  | { kind: "named_predicate"; name: string; text: string };

export interface QueryOutput {
  /** Convenience aliases of statements[0] when the first statement is a query. */
  head: string[];
  rows: Array<Record<string, unknown>>;
  count: number;
  /** Per-statement responses in input order. */
  statements: QueryStatementResult[];
}

export class QueryError extends Error {
  constructor(
    message: string,
    public readonly category: "parse" | "evaluate",
    public readonly span?: { startOffset?: number; endOffset?: number; line?: number; column?: number },
  ) {
    super(message);
    this.name = "QueryError";
  }
}

export function handleQuery(manager: SessionManager, input: QueryInput): QueryOutput {
  const session = manager.get(input.sessionId);
  if (session.mode !== "legacy") {
    throw new QueryError("query is not wired for prelude-free language sessions yet", "evaluate");
  }

  // Accept multi-statement input. Legacy single-statement bodies (bare `?- φ`
  // or bare comprehension) auto-wrap via parseQuery; if `parseStatements`
  // can't parse the whole input as a sequence, fall back to single-statement.
  let parsedStatements;
  try {
    parsedStatements = parseStatements(input.expr);
  } catch {
    // Try the legacy single-query path (auto-wraps `?-` and bare `{...}`).
    try {
      const q = parseQuery(input.expr);
      parsedStatements = [{ kind: "query" as const, query: q }];
    } catch (err) {
      if (err instanceof ParseError) {
        throw new QueryError(err.message, "parse", err.span);
      }
      throw err;
    }
  }

  const out: QueryStatementResult[] = [];
  for (const stmt of parsedStatements) {
    if (stmt.kind === "mutation") {
      throw new QueryError(
        "query tool does not accept def/undef/assert/retract statements (use `mutate`)",
        "parse",
      );
    }
    if (stmt.kind === "query") {
      const ctx = makeContext(session.definition, { state: session.state });
      let result;
      try {
        result = runQuery(stmt.query, ctx);
      } catch (err) {
        throw new QueryError((err as Error).message, "evaluate");
      }
      const rows = result.rows.map((row) => ({ ...row }));
      out.push({
        kind: "query",
        head: stmt.query.head,
        rows,
        count: result.count,
        text: renderQueryRows(stmt.query.head, rows),
      });
    } else if (stmt.kind === "exists") {
      const ctx = makeContext(session.definition, { state: session.state });
      let result;
      try {
        result = runQuery({ head: [], body: stmt.body }, ctx);
      } catch (err) {
        throw new QueryError((err as Error).message, "evaluate");
      }
      const r = result.count > 0;
      out.push({ kind: "exists", result: r, text: `${r};` });
    } else if (stmt.kind === "show") {
      const definition = renderShow(session.definition, stmt.targetKind, stmt.name);
      out.push({
        kind: "show",
        targetKind: stmt.targetKind,
        name: stmt.name,
        definition,
        text: definition,
      });
    } else if (stmt.kind === "named_predicate") {
      // Register the predicate in the session for the duration of the request.
      // (Persistent registration is a future feature; for now this is a no-op
      // that just acknowledges the statement.)
      out.push({
        kind: "named_predicate",
        name: stmt.predicate.name,
        text: `predicate ${stmt.predicate.name} defined;`,
      });
    }
  }

  // Convenience aliases for the first statement when it's a query.
  const first = out[0];
  if (first && first.kind === "query") {
    return { head: first.head, rows: first.rows, count: first.count, statements: out };
  }
  return { head: [], rows: [], count: 0, statements: out };
}

function renderQueryRows(head: string[], rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "[];";
  if (head.length === 0) return `${rows.length > 0};`; // yes/no shouldn't reach here
  if (head.length === 1) {
    const key = head[0]!;
    return `[${rows.map((r) => formatValue(r[key])).join("; ")};];`;
  }
  return `[${rows
    .map(
      (r) =>
        `{ ${head.map((h) => `${h}: ${formatValue(r[h])}`).join(", ")} }`,
    )
    .join("; ")};];`;
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "null";
  return String(v);
}

function renderShow(
  def: import("@quealm/qualms").GameDefinition,
  targetKind: string,
  name: string,
): string {
  // Use the dsl emitter's per-shape helpers.
  switch (targetKind) {
    case "trait":
      return def.hasTrait(name) ? dslNs.emitTrait(def.trait(name)) : `# unknown trait '${name}'`;
    case "relation":
      return def.hasRelation(name)
        ? `def ${dslNs.emitRelation(def.relation(name))};`
        : `# unknown relation '${name}'`;
    case "action":
      return def.hasAction(name)
        ? `def ${dslNs.emitAction(def.action(name))};`
        : `# unknown action '${name}'`;
    case "kind":
      return def.hasKind(name) ? dslNs.emitKind(def.kind(name)) : `# unknown kind '${name}'`;
    case "rulebook":
      return def.hasRulebook(name)
        ? dslNs.emitRulebook(def.rulebook(name))
        : `# unknown rulebook '${name}'`;
    case "rule":
      return def.hasRule(name)
        ? `def ${dslNs.emitRule(def.rule(name))};`
        : `# unknown rule '${name}'`;
    case "entity":
      return def.hasInitialEntity(name)
        ? dslNs.emitEntity(def.initialEntity(name))
        : `# unknown entity '${name}'`;
    default:
      return `# unknown target kind '${targetKind}'`;
  }
}

// ──────── __begin / __mutate / __diff / __commit / __rollback ────────

export interface BeginInput {
  sessionId: string;
  /** Target module for the transaction. `prelude` is read-only and rejected. */
  module: "game" | "session";
  /** Game-module only: target YAML file path for `commit`. Defaults to the single loaded story when unambiguous. */
  targetPath?: string;
}

export interface BeginOutput {
  transactionId: string;
  module: "game" | "session";
  targetPath?: string;
}

export function handleBegin(manager: SessionManager, input: BeginInput): BeginOutput {
  const session = manager.get(input.sessionId);
  if ((input.module as string) === "prelude") {
    throw new MutationError(
      "prelude module is read-only via MCP; edit the prelude file directly",
      "prelude_protected",
    );
  }
  let targetPath = input.targetPath;
  if (input.module === "game" && targetPath === undefined) {
    if (session.storyPaths.length === 1) {
      targetPath = session.storyPaths[0];
    } else {
      throw new MutationError(
        session.storyPaths.length === 0
          ? "game-module begin requires `targetPath` (no story files loaded)"
          : "game-module begin requires explicit `targetPath` (multiple story files loaded)",
        "scope_error",
      );
    }
  }
  const tx = manager.beginTransaction(input.sessionId, input.module, targetPath);
  return {
    transactionId: tx.id,
    module: tx.module,
    ...(tx.targetPath !== undefined ? { targetPath: tx.targetPath } : {}),
  };
}

export interface MutateInput {
  sessionId: string;
  transactionId: string;
  expr: string;
}

export interface MutateAck {
  kind: string;
  summary: string;
}

export interface MutateOutput {
  /** Convenience alias of statements[0] when single-statement input. */
  applied: MutateAck;
  /** Per-statement acks in input order. */
  statements: MutateAck[];
}

export function handleMutate(manager: SessionManager, input: MutateInput): MutateOutput {
  let parsedStatements;
  try {
    parsedStatements = parseStatements(input.expr);
  } catch {
    // Legacy single-statement path.
    try {
      parsedStatements = [parseStatement(input.expr)];
    } catch (err) {
      if (err instanceof ParseError) {
        throw new QueryError(err.message, "parse", err.span);
      }
      throw err;
    }
  }

  const statements: MutateAck[] = [];
  for (const parsed of parsedStatements) {
    if (parsed.kind !== "mutation") {
      throw new QueryError(
        `mutate tool only accepts def/undef/assert/retract/field-assign statements; got ${parsed.kind}`,
        "parse",
      );
    }
    manager.applyMutationToOpenTransaction(
      input.sessionId,
      input.transactionId,
      parsed.mutation,
    );
    statements.push({
      kind: parsed.mutation.type,
      summary: unparseMutation(parsed.mutation),
    });
  }

  const first = statements[0] ?? { kind: "noop", summary: "" };
  return { applied: first, statements };
}

export interface DiffInput {
  sessionId: string;
  transactionId: string;
}

export interface DiffOutput {
  module: "game" | "session";
  applied: Array<{ expr: string; kind: string }>;
  summary: {
    traits: { added: number; removed: number };
    relations: { added: number; removed: number };
    actions: { added: number; removed: number };
    kinds: { added: number; removed: number };
    rules: { added: number; removed: number };
    rulebooks: { added: number; removed: number };
    entities: { added: number; removed: number };
    assertions: { added: number; removed: number };
    fieldAssigns: number;
  };
}

export function handleDiff(manager: SessionManager, input: DiffInput): DiffOutput {
  const { session, transaction } = manager.requireTransaction(
    input.sessionId,
    input.transactionId,
  );
  const before = transaction.defSnapshot;
  const after = session.definition;
  const summary = {
    traits: setDiff([...before.traits.keys()], [...after.traits.keys()]),
    relations: setDiff([...before.relations.keys()], [...after.relations.keys()]),
    actions: setDiff([...before.actions.keys()], [...after.actions.keys()]),
    kinds: setDiff([...before.kinds.keys()], [...after.kinds.keys()]),
    rules: setDiff(before.rules.map((r) => r.id), after.rules.map((r) => r.id)),
    rulebooks: setDiff([...before.rulebooks.keys()], [...after.rulebooks.keys()]),
    entities: setDiff(
      before.initialEntities.map((e) => e.id),
      after.initialEntities.map((e) => e.id),
    ),
    assertions: setDiff(
      before.initialAssertions.map((a) => `${a.relation}|${JSON.stringify(a.args)}`),
      after.initialAssertions.map((a) => `${a.relation}|${JSON.stringify(a.args)}`),
    ),
    fieldAssigns: transaction.applied.filter((m) => m.type === "fieldAssign").length,
  };
  return {
    module: transaction.module,
    applied: transaction.applied.map((m) => ({
      kind: m.type,
      expr: unparseMutation(m),
    })),
    summary,
  };
}

function setDiff(before: string[], after: string[]): { added: number; removed: number } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  let added = 0;
  let removed = 0;
  for (const a of afterSet) if (!beforeSet.has(a)) added++;
  for (const b of beforeSet) if (!afterSet.has(b)) removed++;
  return { added, removed };
}

export interface CommitInput {
  sessionId: string;
  transactionId: string;
}

export interface CommitOutput {
  committed: number;
  persisted: boolean;
  /** Present when persisted: the YAML file overwritten on disk. */
  targetPath?: string;
  /** Present when persisted=false: explanation. */
  reason?: string;
}

export function handleCommit(manager: SessionManager, input: CommitInput): CommitOutput {
  const { session, transaction } = manager.requireTransaction(
    input.sessionId,
    input.transactionId,
  );
  // For game-module commits, write the game slice to disk. For session-module,
  // commit lands in-memory only — disk persistence rides on gameplay save.
  if (transaction.module === "game") {
    if (transaction.targetPath === undefined) {
      throw new MutationError(
        "game-module commit requires a targetPath set at begin",
        "scope_error",
      );
    }
    const dslText = emitDsl(session.definition, "game");
    writeFileSync(transaction.targetPath, dslText, "utf-8");
    const result = manager.commit(input.sessionId, input.transactionId);
    return {
      committed: result.committed,
      persisted: true,
      targetPath: transaction.targetPath,
    };
  }
  const result = manager.commit(input.sessionId, input.transactionId);
  return {
    committed: result.committed,
    persisted: false,
    reason: "session-save-deferred",
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

// ──────── play (advance one turn by invoking an action) ────────

export interface PlayInput {
  sessionId: string;
  action?: string;
  call?: string;
  args?: Record<string, unknown>;
}

export interface PlayOutput {
  action: string;
  args: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  effectsApplied: number;
}

export function handlePlay(manager: SessionManager, input: PlayInput): PlayOutput {
  const session = manager.get(input.sessionId);
  if (session.mode === "language") {
    if (!input.call) {
      throw new PlayError("language sessions require `call`, e.g. `Go(Player, Outside)`", "missing_arg");
    }
    const result = languageNs.playLanguageCall(session.languageModel, input.call);
    return {
      action: input.call,
      args: {},
      events: [{ status: result.status, feedback: result.feedback, reasons: result.reasons }],
      effectsApplied: 0,
    };
  }
  if (!input.action) {
    throw new PlayError("missing action", "missing_arg");
  }
  const result = playAction(
    session.definition,
    session.state,
    input.action,
    input.args ?? {},
  );
  return result;
}

export { MutationError, PlayError };

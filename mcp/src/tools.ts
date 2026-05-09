/**
 * Tool handlers — pure functions over the SessionManager. The MCP server in
 * server.ts wraps these with the SDK's request/response plumbing; the unit
 * tests exercise them directly.
 */

import { writeFileSync } from "node:fs";
import {
  mutation as mutationNs,
  query as queryNs,
  yaml as yamlNs,
} from "@quealm/qualms";
import type { SessionManager } from "./session.js";

const { makeContext, parseQuery, parseStatement, runQuery, ParseError } = queryNs;
const { MutationError, unparseMutation } = mutationNs;
const { emitDefinition } = yamlNs;

// ──────── __start ────────

export interface StartInput {
  corePath: string;
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
  if (!input.corePath) {
    throw new Error("corePath is required");
  }
  const session = manager.start({
    corePath: input.corePath,
    ...(input.storyPaths ? { storyPaths: input.storyPaths } : {}),
  });
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

// ──────── __query ────────

export interface QueryInput {
  sessionId: string;
  expr: string;
}

export interface QueryOutput {
  head: string[];
  rows: Array<Record<string, unknown>>;
  count: number;
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
  let parsed;
  try {
    parsed = parseQuery(input.expr);
  } catch (err) {
    if (err instanceof ParseError) {
      throw new QueryError(err.message, "parse", err.span);
    }
    throw err;
  }
  const ctx = makeContext(session.definition, { state: session.state });
  let result;
  try {
    result = runQuery(parsed, ctx);
  } catch (err) {
    throw new QueryError((err as Error).message, "evaluate");
  }
  return {
    head: parsed.head,
    rows: result.rows.map((row) => ({ ...row })),
    count: result.count,
  };
}

// ──────── __begin / __mutate / __diff / __commit / __rollback ────────

export interface BeginInput {
  sessionId: string;
  scope: "story" | "session";
  /** Story-scope only: target YAML file path for `__commit`. Defaults to the single loaded story when unambiguous. */
  targetPath?: string;
}

export interface BeginOutput {
  transactionId: string;
  scope: "story" | "session";
  layer: "game" | "session";
  targetPath?: string;
}

export function handleBegin(manager: SessionManager, input: BeginInput): BeginOutput {
  const session = manager.get(input.sessionId);
  let targetPath = input.targetPath;
  if (input.scope === "story" && targetPath === undefined) {
    if (session.storyPaths.length === 1) {
      targetPath = session.storyPaths[0];
    } else {
      throw new MutationError(
        session.storyPaths.length === 0
          ? "story-scope __begin requires `targetPath` (no story files loaded)"
          : "story-scope __begin requires explicit `targetPath` (multiple story files loaded)",
        "scope_error",
      );
    }
  }
  const tx = manager.beginTransaction(input.sessionId, input.scope, targetPath);
  return {
    transactionId: tx.id,
    scope: tx.scope,
    layer: tx.layer as "game" | "session",
    ...(tx.targetPath !== undefined ? { targetPath: tx.targetPath } : {}),
  };
}

export interface MutateInput {
  sessionId: string;
  transactionId: string;
  expr: string;
}

export interface MutateOutput {
  applied: { kind: string; summary: string };
}

export function handleMutate(manager: SessionManager, input: MutateInput): MutateOutput {
  let parsed;
  try {
    parsed = parseStatement(input.expr);
  } catch (err) {
    if (err instanceof ParseError) {
      throw new QueryError(err.message, "parse", err.span);
    }
    throw err;
  }
  if (parsed.kind !== "mutation") {
    throw new QueryError(
      `expected a mutation statement, got ${parsed.kind}`,
      "parse",
    );
  }
  manager.applyMutationToOpenTransaction(input.sessionId, input.transactionId, parsed.mutation);
  return {
    applied: {
      kind: parsed.mutation.type,
      summary: unparseMutation(parsed.mutation),
    },
  };
}

export interface DiffInput {
  sessionId: string;
  transactionId: string;
}

export interface DiffOutput {
  scope: "story" | "session";
  layer: "game" | "session";
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
    scope: transaction.scope,
    layer: transaction.layer as "game" | "session",
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
  // For story scope, write the game-layer slice to disk. For session scope,
  // commit lands in-memory only — disk persistence rides on gameplay __save.
  if (transaction.scope === "story") {
    if (transaction.targetPath === undefined) {
      throw new MutationError(
        "story-scope commit requires a targetPath set at __begin",
        "scope_error",
      );
    }
    const yamlText = emitDefinition(session.definition, "game");
    writeFileSync(transaction.targetPath, yamlText, "utf-8");
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

export { MutationError };

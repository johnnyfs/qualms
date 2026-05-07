/**
 * Tool handlers — pure functions over the SessionManager. The MCP server in
 * server.ts wraps these with the SDK's request/response plumbing; the unit
 * tests exercise them directly.
 */

import { query as queryNs } from "@quealm/qualms";
import type { SessionManager } from "./session.js";

const { makeContext, parseQuery, runQuery, ParseError } = queryNs;

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

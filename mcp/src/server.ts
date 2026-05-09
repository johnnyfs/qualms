/**
 * MCP server wiring — registers the lifecycle, query, and mutation tools on
 * an McpServer instance backed by a SessionManager. Tool names omit the
 * `__` prefix; the framework prepends `mcp__qualms__` at the wire level so
 * `start` is exposed as `mcp__qualms__start`. The CLI in cli.ts wires this
 * server to a stdio transport and starts it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import {
  SessionManager,
  SessionNotFoundError,
  TransactionAlreadyOpenError,
  TransactionNotFoundError,
} from "./session.js";
import {
  MutationError,
  QueryError,
  handleBegin,
  handleCommit,
  handleDiff,
  handleMutate,
  handleQuery,
  handleQuit,
  handleRollback,
  handleStart,
} from "./tools.js";

export const SERVER_NAME = "qualms-mcp";
export const SERVER_VERSION = "0.1.0";

export interface BuildServerOptions {
  manager?: SessionManager;
}

export function buildServer(options: BuildServerOptions = {}): {
  server: McpServer;
  manager: SessionManager;
} {
  const manager = options.manager ?? new SessionManager();
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "start",
    {
      description:
        "Load a core prelude (read-only) and zero or more story files into a new session. " +
        "Returns a session id used by subsequent calls.",
      inputSchema: {
        corePath: z
          .string()
          .describe("Filesystem path to the prelude YAML (e.g. qualms/prelude/core.qualms.yaml)."),
        storyPaths: z
          .array(z.string())
          .optional()
          .describe("Optional list of story YAML paths to load on top of the prelude."),
      },
    },
    async (args) => {
      try {
        const out = handleStart(manager, {
          corePath: args.corePath,
          ...(args.storyPaths ? { storyPaths: args.storyPaths } : {}),
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(out, null, 2),
            },
          ],
          structuredContent: out as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "quit",
    {
      description: "Terminate a session and release its resources.",
      inputSchema: {
        sessionId: z.string(),
      },
    },
    async (args) => {
      try {
        const out = handleQuit(manager, { sessionId: args.sessionId });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out) }],
          structuredContent: out as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "query",
    {
      description:
        "Run a query against the loaded definition+state. Accepts the DSL surface " +
        "syntax (comprehension `{ x : T | φ }`, predicate query `?- φ`, ...). " +
        "Returns projected variable bindings.",
      inputSchema: {
        sessionId: z.string(),
        expr: z
          .string()
          .describe(
            "Query expression. Examples: `{ k : Kind | uses(k, \"Presentable\") }`, " +
              "`?- exists r : Relation. r.id = \"IsPlayer\"`",
          ),
      },
    },
    async (args) => {
      try {
        const out = handleQuery(manager, { sessionId: args.sessionId, expr: args.expr });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(out, null, 2) },
          ],
          structuredContent: out as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "begin",
    {
      description:
        "Open a structural transaction. Mutations apply in-place to the live " +
        "definition + state so `query` mid-transaction sees pending changes; " +
        "`rollback` restores the snapshot. One open transaction per session.",
      inputSchema: {
        sessionId: z.string(),
        scope: z
          .enum(["story", "session"])
          .describe(
            "story: mutations land at the `game` layer; `commit` writes the " +
              "game-layer slice to `targetPath` on disk. " +
              "session: mutations land at the `session` layer; `commit` is in-memory " +
              "only this milestone (gameplay `save` lands later).",
          ),
        targetPath: z
          .string()
          .optional()
          .describe(
            "Story-scope only: target YAML file path for `commit`. Defaults to " +
              "the single loaded story file when unambiguous.",
          ),
      },
    },
    async (args) => {
      try {
        const out = handleBegin(manager, {
          sessionId: args.sessionId,
          scope: args.scope,
          ...(args.targetPath !== undefined ? { targetPath: args.targetPath } : {}),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
          structuredContent: out as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "mutate",
    {
      description:
        "Apply a single mutation statement (assert/retract/:= / def / undef) " +
        "to the open transaction. Errors surface with category=parse for " +
        "syntax issues, mutation-error categories for semantic ones.",
      inputSchema: {
        sessionId: z.string(),
        transactionId: z.string(),
        expr: z
          .string()
          .describe(
            "Mutation statement. Examples: `def trait Combatant { fields: { hp: { default: 10 } } }`, " +
              "`def entity grunt : Foe {}`, `assert IsPlayer(\"grunt\")`, " +
              "`grunt.hp := 5`, `undef trait Combatant`.",
          ),
      },
    },
    async (args) => {
      try {
        const out = handleMutate(manager, {
          sessionId: args.sessionId,
          transactionId: args.transactionId,
          expr: args.expr,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
          structuredContent: out as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "diff",
    {
      description:
        "Report the mutations applied so far in the open transaction, plus a " +
        "summary count of structural objects added/removed by category.",
      inputSchema: {
        sessionId: z.string(),
        transactionId: z.string(),
      },
    },
    async (args) => {
      try {
        const out = handleDiff(manager, {
          sessionId: args.sessionId,
          transactionId: args.transactionId,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
          structuredContent: out as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "commit",
    {
      description:
        "Finalize the open transaction. Story-scope writes the game-layer slice " +
        "to the YAML file given at `begin` (response: persisted=true, targetPath). " +
        "Session-scope finalizes in memory only; persistence rides on gameplay " +
        "`save` (response: persisted=false, reason=\"session-save-deferred\").",
      inputSchema: {
        sessionId: z.string(),
        transactionId: z.string(),
      },
    },
    async (args) => {
      try {
        const out = handleCommit(manager, {
          sessionId: args.sessionId,
          transactionId: args.transactionId,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
          structuredContent: out as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "rollback",
    {
      description:
        "Discard the open transaction's changes; restore the live def + state " +
        "to the snapshot taken at `begin`.",
      inputSchema: {
        sessionId: z.string(),
        transactionId: z.string(),
      },
    },
    async (args) => {
      try {
        const out = handleRollback(manager, {
          sessionId: args.sessionId,
          transactionId: args.transactionId,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }],
          structuredContent: out as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return { server, manager };
}

export async function startServer(transport: Transport, options: BuildServerOptions = {}): Promise<{
  server: McpServer;
  manager: SessionManager;
}> {
  const built = buildServer(options);
  await built.server.connect(transport);
  return built;
}

function errorResult(err: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  let message: string;
  if (err instanceof QueryError) {
    const span = err.span ? ` (offset ${err.span.startOffset ?? "?"})` : "";
    message = `[${err.category}] ${err.message}${span}`;
  } else if (err instanceof MutationError) {
    message = `[${err.category}] ${err.message}`;
  } else if (
    err instanceof TransactionNotFoundError ||
    err instanceof TransactionAlreadyOpenError ||
    err instanceof SessionNotFoundError
  ) {
    message = err.message;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

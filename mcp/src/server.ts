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
  PlayError,
  QueryError,
  handleBegin,
  handleCommit,
  handleDiff,
  handleMutate,
  handlePlay,
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
          .describe("Filesystem path to the prelude YAML (e.g. qualms/prelude/core.qualms)."),
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
        "Run one or more read-only DSL statements against the loaded definition+state. " +
        "Accepts `query { vars | φ };`, `exists { φ };` (yes/no), `show <kind> <name>;`, " +
        "and named-predicate definitions `name(p1, p2) :- φ;`. Multi-statement input " +
        "(separated by `;`) returns one response per statement. Rejects `def`/`undef` " +
        "(use `mutate`).",
      inputSchema: {
        sessionId: z.string(),
        expr: z
          .string()
          .describe(
            "DSL statement(s). Examples: `query { k | k : Kind & uses(k, \"Presentable\") };`, " +
              "`exists { ∃ r : Relation. r.id = \"IsPlayer\" };`, `show trait Presentable;`. " +
              "Legacy bare forms `?- φ` and `{ x | φ }` are auto-wrapped for backward compatibility.",
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
        module: z
          .enum(["game", "session"])
          .describe(
            "game: mutations land at the game module; `commit` writes the game " +
              "slice to `targetPath` on disk. " +
              "session: mutations land at the session module; `commit` is in-memory " +
              "only this milestone (gameplay `save` lands later). " +
              "prelude is read-only via MCP and rejected.",
          ),
        targetPath: z
          .string()
          .optional()
          .describe(
            "Game-module only: target YAML file path for `commit`. Defaults to " +
              "the single loaded story file when unambiguous.",
          ),
      },
    },
    async (args) => {
      try {
        const out = handleBegin(manager, {
          sessionId: args.sessionId,
          module: args.module,
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
        "Apply one or more mutation statements (def / undef / assert / retract / `:=`) " +
        "to the open transaction. Multi-statement input (separated by `;`) applies in " +
        "order and returns one ack per statement. Errors surface with category=parse for " +
        "syntax issues, mutation-error categories for semantic ones. Rejects " +
        "`query`/`exists`/`show` (use `query`).",
      inputSchema: {
        sessionId: z.string(),
        transactionId: z.string(),
        expr: z
          .string()
          .describe(
            "Mutation statement(s). Examples: `def trait Combatant { hp: int = 10 };`, " +
              "`def kind Foe: Combatant, Presentable;`, " +
              "`def entity grunt: Foe { Presentable.name = \"Grunt\" };`, " +
              "`assert IsPlayer(\"grunt\");`, `grunt.hp := 5;`, `undef trait Combatant;`.",
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
        "Finalize the open transaction. Game-module writes the game slice " +
        "to the YAML file given at `begin` (response: persisted=true, targetPath). " +
        "Session-module finalizes in memory only; persistence rides on gameplay " +
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
    "play",
    {
      description:
        "Advance play one turn by invoking an action. Resolves the action, " +
        "binds parameters from `args`, evaluates `requires` against current " +
        "state, then applies the action's effects (assert/retract/`:=`/" +
        "`+=`/`-=`/emit) to the live session_state. Returns emitted events. " +
        "No transaction needed — runtime mutations bypass the structural log. " +
        "Rules engine (before/during/after rule firing) is not implemented; " +
        "only the action's own effects run.",
      inputSchema: {
        sessionId: z.string(),
        action: z
          .string()
          .describe("Action id, e.g. \"Take\", \"Move\", \"Examine\"."),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Parameter bindings keyed by parameter name. Values are entity " +
              "ids (strings) or primitive scalars. Missing parameters with " +
              "defaults use their default; missing required parameters error.",
          ),
      },
    },
    async (args) => {
      try {
        const out = handlePlay(manager, {
          sessionId: args.sessionId,
          action: args.action,
          ...(args.args !== undefined ? { args: args.args } : {}),
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
  } else if (err instanceof PlayError) {
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

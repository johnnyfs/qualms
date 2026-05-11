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
        "Start a Qualms session using tutorial-era `.qualms` DSL files. No prelude or YAML story format is loaded.",
      inputSchema: {
        storyPaths: z
          .array(z.string())
          .optional()
          .describe("Optional list of `.qualms` files written in the current tutorial DSL syntax."),
      },
    },
    async (args) => toolResult(() => handleStart(manager, args)),
  );

  server.registerTool(
    "quit",
    {
      description: "Terminate a session and release its resources.",
      inputSchema: {
        sessionId: z.string(),
      },
    },
    async (args) => toolResult(() => handleQuit(manager, args)),
  );

  server.registerTool(
    "query",
    {
      description:
        "Inspect the loaded story model. Omit `expr` or pass `facts` for a summary; pass `show`, `show <kind>`, or `show <kind> <name>` for definitions; pass a DSL expression such as `At(actor, Cell)` or `Locked(Bars) & LockedWith(Bars, key)` for pattern results.",
      inputSchema: {
        sessionId: z.string(),
        expr: z.string().optional(),
      },
    },
    async (args) => toolResult(() => handleQuery(manager, args)),
  );

  server.registerTool(
    "begin",
    {
      description:
        "Open a transaction over the current story model. Mutations are visible immediately and can be rolled back or committed.",
      inputSchema: {
        sessionId: z.string(),
        targetPath: z
          .string()
          .optional()
          .describe("Optional `.qualms` path to overwrite with normalized DSL on commit."),
      },
    },
    async (args) => toolResult(() => handleBegin(manager, args)),
  );

  server.registerTool(
    "mutate",
    {
      description:
        "Apply one or more tutorial DSL top-level statements to an open transaction. Examples include `trait`, `relation`, `action`, `predicate`, `before`, `after`, `entity`, `extend`, and `set`.",
      inputSchema: {
        sessionId: z.string(),
        transactionId: z.string(),
        expr: z.string().describe("A complete DSL program fragment in the current `.qualms` syntax."),
      },
    },
    async (args) => toolResult(() => handleMutate(manager, args)),
  );

  server.registerTool(
    "diff",
    {
      description:
        "Report DSL snippets applied during the open transaction and model counts before/after.",
      inputSchema: {
        sessionId: z.string(),
        transactionId: z.string(),
      },
    },
    async (args) => toolResult(() => handleDiff(manager, args)),
  );

  server.registerTool(
    "commit",
    {
      description:
        "Finalize the open transaction. If a target path is available, writes the normalized `.qualms` story model.",
      inputSchema: {
        sessionId: z.string(),
        transactionId: z.string(),
      },
    },
    async (args) => toolResult(() => handleCommit(manager, args)),
  );

  server.registerTool(
    "rollback",
    {
      description: "Discard the open transaction and restore its snapshot.",
      inputSchema: {
        sessionId: z.string(),
        transactionId: z.string(),
      },
    },
    async (args) => toolResult(() => handleRollback(manager, args)),
  );

  server.registerTool(
    "play",
    {
      description:
        "Run an action call in the current DSL syntax, such as `Go(Player, Outside)`. Returns compact DSL feedback, e.g. `pass;` or `fail { !Path(Cell, Outside); }`.",
      inputSchema: {
        sessionId: z.string(),
        call: z.string().describe("Action call in current DSL syntax."),
      },
    },
    async (args) => toolResult(() => handlePlay(manager, args)),
  );

  return { server, manager };
}

export async function startServer(
  transport: Transport,
  options: BuildServerOptions = {},
): Promise<{
  server: McpServer;
  manager: SessionManager;
}> {
  const built = buildServer(options);
  await built.server.connect(transport);
  return built;
}

function toolResult(fn: () => unknown): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} | {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  try {
    const out = fn();
    return {
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      structuredContent: out as Record<string, unknown>,
    };
  } catch (err) {
    return errorResult(err);
  }
}

function errorResult(err: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  let message: string;
  if (err instanceof QueryError || err instanceof MutationError || err instanceof PlayError) {
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
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

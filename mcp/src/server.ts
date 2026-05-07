/**
 * MCP server wiring — registers __start, __quit, __query tools on an
 * McpServer instance backed by a SessionManager. The CLI in cli.ts wires
 * this server to a stdio transport and starts it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { SessionManager, SessionNotFoundError } from "./session.js";
import {
  QueryError,
  handleQuery,
  handleQuit,
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
    "__start",
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
    "__quit",
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
    "__query",
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
  } else if (err instanceof SessionNotFoundError) {
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

/**
 * Manual prod-test driver. Spawns the qualms-mcp server as a subprocess,
 * exercises __start / __query / __quit end-to-end via the official MCP
 * client, and prints structured results. Step 6 of the migration plan.
 *
 * Run from repo root:
 *   pnpm --filter @quealm/mcp exec tsx scripts/smoke.ts
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");
const PRELUDE_PATH = resolve(REPO_ROOT, "qualms/prelude/core.qualms.yaml");
const CLI_PATH = resolve(REPO_ROOT, "mcp/src/cli.ts");

const TSX = resolve(REPO_ROOT, "mcp/node_modules/.bin/tsx");

interface CallResult {
  label: string;
  ok: boolean;
  structured?: unknown;
  text?: string;
  error?: string;
  durationMs: number;
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: TSX,
    args: [CLI_PATH, "--core", PRELUDE_PATH],
    cwd: REPO_ROOT,
  });
  const client = new Client({ name: "qualms-smoke", version: "0.0.1" });
  console.log("# Smoke test against qualms-mcp\n");
  console.log(`prelude: ${PRELUDE_PATH}\n`);

  await client.connect(transport);
  const results: CallResult[] = [];

  try {
    // Tools list
    const tools = await client.listTools();
    console.log(`tools.list returned ${tools.tools.length} tools:`);
    for (const t of tools.tools) {
      console.log(`  - ${t.name}: ${t.description?.split("\n")[0] ?? ""}`);
    }
    console.log();

    // __start
    let sessionId: string | undefined;
    {
      const r = await timed("__start", () =>
        client.callTool({
          name: "__start",
          arguments: { corePath: PRELUDE_PATH },
        }),
      );
      results.push(r);
      const sc = r.structured as { sessionId?: string } | undefined;
      sessionId = sc?.sessionId;
    }
    if (!sessionId) throw new Error("__start did not return a session id");

    // Battery of __query calls
    const queries: { label: string; expr: string }[] = [
      { label: "kinds with Presentable", expr: '{ k : Kind | uses(k, "Presentable") }' },
      { label: "Item kind contents", expr: '{ t | uses("Item", t) }' },
      { label: "IsPlayer relation exists", expr: '?- exists r : Relation. r.id = "IsPlayer"' },
      { label: "SequenceComplete absent", expr: '?- exists r : Relation. r.id = "SequenceComplete"' },
      { label: "/^Can/ prelude relations", expr: '{ r : Relation@prelude | r.id =~ /^Can/ }' },
      { label: "@game traits empty", expr: "{ t : Trait@game | true }" },
      { label: "all prelude traits", expr: "{ t : Trait@prelude | true }" },
      { label: "rules count via meta", expr: "{ r : Rule | true }" },
      { label: "actions in prelude", expr: "{ a : Action@prelude | true }" },
    ];
    for (const q of queries) {
      results.push(
        await timed(`__query (${q.label})`, () =>
          client.callTool({
            name: "__query",
            arguments: { sessionId: sessionId!, expr: q.expr },
          }),
        ),
      );
    }

    // Negative cases
    results.push(
      await timed("__query bad sessionId", () =>
        client.callTool({
          name: "__query",
          arguments: { sessionId: "nope", expr: "?- true" },
        }),
      ),
    );
    results.push(
      await timed("__query parse error", () =>
        client.callTool({
          name: "__query",
          arguments: { sessionId: sessionId!, expr: "?- @bad" },
        }),
      ),
    );

    // __quit
    results.push(
      await timed("__quit", () =>
        client.callTool({
          name: "__quit",
          arguments: { sessionId: sessionId! },
        }),
      ),
    );

    // Verify post-quit query fails
    results.push(
      await timed("__query after quit", () =>
        client.callTool({
          name: "__query",
          arguments: { sessionId: sessionId!, expr: "?- true" },
        }),
      ),
    );
  } finally {
    await client.close();
  }

  // Pretty-print
  for (const r of results) {
    console.log(`## ${r.label}`);
    console.log(`  ok=${r.ok} duration=${r.durationMs}ms`);
    if (r.structured !== undefined) {
      console.log("  structured:", JSON.stringify(r.structured, null, 2).split("\n").join("\n  "));
    } else if (r.text !== undefined) {
      console.log("  text:", r.text);
    }
    if (r.error) console.log("  error:", r.error);
    console.log();
  }
}

async function timed(
  label: string,
  fn: () => Promise<{
    isError?: boolean;
    structuredContent?: unknown;
    content?: { type: string; text?: string }[];
  }>,
): Promise<CallResult> {
  const start = Date.now();
  try {
    const out = await fn();
    const durationMs = Date.now() - start;
    const ok = out.isError !== true;
    const textBlock = out.content?.find((c) => c.type === "text")?.text;
    return {
      label,
      ok,
      ...(out.structuredContent !== undefined ? { structured: out.structuredContent } : {}),
      ...(textBlock !== undefined ? { text: textBlock } : {}),
      durationMs,
    };
  } catch (err) {
    return {
      label,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

main().catch((err) => {
  console.error("smoke driver failed:", err);
  process.exit(1);
});

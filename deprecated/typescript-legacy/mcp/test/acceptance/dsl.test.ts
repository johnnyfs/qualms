/**
 * DSL v2 acceptance tests for the multi-statement query/mutate surface and
 * the show/exists routing.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, "../../../..");
const PRELUDE_PATH = resolve(REPO_ROOT, "qualms/prelude/core.qualms");
const CLI_PATH = resolve(REPO_ROOT, "mcp/src/cli.ts");
const TSX = resolve(REPO_ROOT, "mcp/node_modules/.bin/tsx");

interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: { type: string; text?: string }[];
}

async function startClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: TSX,
    args: [CLI_PATH, "--core", PRELUDE_PATH],
    cwd: REPO_ROOT,
  });
  const client = new Client({ name: "qualms-dsl-acceptance", version: "0.0.1" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function start(client: Client): Promise<string> {
  const r = (await client.callTool({
    name: "start",
    arguments: { corePath: PRELUDE_PATH },
  })) as ToolResult;
  expect(r.isError).not.toBe(true);
  return (r.structuredContent as { sessionId: string }).sessionId;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

describe("dsl acceptance: query verbs", () => {
  let client: Client;
  let close: () => Promise<void>;
  let sessionId: string;
  beforeAll(async () => {
    ({ client, close } = await startClient());
    sessionId = await start(client);
  });
  afterAll(async () => {
    await close();
  });

  it("query { vars | … } returns rows", async () => {
    const r = await call(client, "query", {
      sessionId,
      expr: 'query { k | k : Kind & uses(k, "Presentable") };',
    });
    const sc = r.structuredContent as { statements: { kind: string; rows: unknown[]; count: number }[] };
    expect(sc.statements).toHaveLength(1);
    expect(sc.statements[0]!.kind).toBe("query");
    expect(sc.statements[0]!.count).toBe(4);
  });

  it("exists { … } returns true/false", async () => {
    const yes = await call(client, "query", {
      sessionId,
      expr: 'exists { exists r : Relation. r.id = "IsPlayer" };',
    });
    const ysc = yes.structuredContent as { statements: { kind: string; result: boolean }[] };
    expect(ysc.statements[0]).toEqual({ kind: "exists", result: true, text: "true;" });

    const no = await call(client, "query", {
      sessionId,
      expr: 'exists { exists r : Relation. r.id = "Nope" };',
    });
    const nsc = no.structuredContent as { statements: { kind: string; result: boolean }[] };
    expect(nsc.statements[0]).toEqual({ kind: "exists", result: false, text: "false;" });
  });

  it("show <kind> <name> returns the rendered DSL block", async () => {
    const r = await call(client, "query", {
      sessionId,
      expr: "show trait Presentable;",
    });
    const sc = r.structuredContent as {
      statements: { kind: string; targetKind: string; name: string; definition: string }[];
    };
    expect(sc.statements[0]!.kind).toBe("show");
    expect(sc.statements[0]!.definition).toContain("def trait Presentable");
    expect(sc.statements[0]!.definition).toContain("name: str");
  });

  it("multi-statement input returns one response per statement", async () => {
    const r = await call(client, "query", {
      sessionId,
      expr:
        'query { k | k : Kind }; exists { exists r : Relation. r.id = "IsPlayer" }; show kind Item;',
    });
    const sc = r.structuredContent as { statements: { kind: string }[] };
    expect(sc.statements.map((s) => s.kind)).toEqual(["query", "exists", "show"]);
  });

  it("query rejects def/undef statements", async () => {
    const r = await call(client, "query", {
      sessionId,
      expr: "def trait Foo {};",
    });
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/use `mutate`/);
  });
});

describe("dsl acceptance: mutate kind enforcement", () => {
  let client: Client;
  let close: () => Promise<void>;
  let sessionId: string;
  beforeAll(async () => {
    ({ client, close } = await startClient());
    sessionId = await start(client);
  });
  afterAll(async () => {
    await close();
  });

  it("mutate rejects query/exists/show statements", async () => {
    const begin = await call(client, "begin", { sessionId, module: "session" });
    const tx = (begin.structuredContent as { transactionId: string }).transactionId;
    const r = await call(client, "mutate", {
      sessionId,
      transactionId: tx,
      expr: "query { k | k : Kind };",
    });
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/mutate tool only accepts/);
    await call(client, "rollback", { sessionId, transactionId: tx });
  });

  it("mutate accepts multi-statement def + applies in order", async () => {
    const begin = await call(client, "begin", { sessionId, module: "session" });
    const tx = (begin.structuredContent as { transactionId: string }).transactionId;
    const r = await call(client, "mutate", {
      sessionId,
      transactionId: tx,
      expr:
        "def trait Combatant { hp: int = 10 }; def kind Foe: Combatant, Presentable; def entity g: Foe { Combatant.hp = 5 };",
    });
    expect(r.isError).not.toBe(true);
    const sc = r.structuredContent as { statements: { kind: string }[] };
    expect(sc.statements.map((s) => s.kind)).toEqual(["defTrait", "defKind", "defEntity"]);

    // Verify with `query` that the entity exists.
    const q = await call(client, "query", {
      sessionId,
      expr: 'query { e | e : Entity & instance_of(e, "Foe") };',
    });
    const qsc = q.structuredContent as { statements: { kind: string; rows: unknown[] }[] };
    expect(qsc.statements[0]!.rows).toHaveLength(1);

    await call(client, "rollback", { sessionId, transactionId: tx });
  });
});

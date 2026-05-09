/**
 * External acceptance tests — spawn qualms-mcp as a subprocess, drive it via
 * the official MCP client, and assert on responses. This validates the full
 * pipeline (transport → server → tools → engine → DSL) end-to-end.
 *
 * Each test starts a fresh session via __start; tests do not share state.
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
  const client = new Client({ name: "qualms-acceptance", version: "0.0.1" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function startMissingCoreClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: TSX,
    args: [CLI_PATH, "--core", "/nope/missing.yaml"],
    cwd: REPO_ROOT,
  });
  const client = new Client({ name: "qualms-acceptance-bad", version: "0.0.1" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function start(client: Client): Promise<string> {
  const r = (await client.callTool({
    name: "start",
    arguments: { corePath: PRELUDE_PATH },
  })) as ToolResult;
  expect(r.isError).not.toBe(true);
  const sc = r.structuredContent as { sessionId: string };
  return sc.sessionId;
}

async function query(
  client: Client,
  sessionId: string,
  expr: string,
): Promise<ToolResult> {
  return (await client.callTool({
    name: "query",
    arguments: { sessionId, expr },
  })) as ToolResult;
}

describe("MCP server: tool discovery", () => {
  let client: Client;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const c = await startClient();
    client = c.client;
    close = c.close;
  });
  afterAll(async () => {
    await close();
  });

  it("lists the full tool set including mutation tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "begin",
      "commit",
      "diff",
      "mutate",
      "query",
      "quit",
      "rollback",
      "start",
    ]);
  });
});

describe("MCP server: lifecycle", () => {
  let client: Client;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const c = await startClient();
    client = c.client;
    close = c.close;
  });
  afterAll(async () => {
    await close();
  });

  it("__start with valid core succeeds and reports counts", async () => {
    const r = (await client.callTool({
      name: "start",
      arguments: { corePath: PRELUDE_PATH },
    })) as ToolResult;
    expect(r.isError).not.toBe(true);
    const sc = r.structuredContent as {
      sessionId: string;
      loaded: { counts: Record<string, number> };
    };
    expect(sc.sessionId).toMatch(/[0-9a-f-]+/);
    expect(sc.loaded.counts.kinds).toBe(4);
    expect(sc.loaded.counts.traits).toBe(10);
  });

  it("__start with missing core returns isError", async () => {
    const r = (await client.callTool({
      name: "start",
      arguments: { corePath: "/totally/does/not/exist.yaml" },
    })) as ToolResult;
    expect(r.isError).toBe(true);
    const text = r.content?.find((c) => c.type === "text")?.text ?? "";
    expect(text).toMatch(/no such file|ENOENT/i);
  });

  it("__quit with valid id returns ok=true; quit on dead id returns ok=false", async () => {
    const sessionId = await start(client);
    const r1 = (await client.callTool({
      name: "quit",
      arguments: { sessionId },
    })) as ToolResult;
    expect((r1.structuredContent as { ok: boolean }).ok).toBe(true);
    const r2 = (await client.callTool({
      name: "quit",
      arguments: { sessionId },
    })) as ToolResult;
    expect((r2.structuredContent as { ok: boolean }).ok).toBe(false);
  });

  it("__query on a dead session id returns isError", async () => {
    const r = (await client.callTool({
      name: "query",
      arguments: { sessionId: "ghost", expr: "?- true" },
    })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/not found/);
  });
});

describe("MCP server: query correctness", () => {
  let client: Client;
  let close: () => Promise<void>;
  let sessionId: string;
  beforeAll(async () => {
    const c = await startClient();
    client = c.client;
    close = c.close;
    sessionId = await start(client);
  });
  afterAll(async () => {
    await close();
  });

  it("kinds with Presentable returns Thing/Place/Person/Item", async () => {
    const r = await query(client, sessionId, '{ k : Kind | uses(k, "Presentable") }');
    const sc = r.structuredContent as { rows: { k: string }[]; count: number };
    expect(sc.count).toBe(4);
    expect(new Set(sc.rows.map((row) => row.k))).toEqual(
      new Set(["Thing", "Place", "Person", "Item"]),
    );
  });

  it("Item kind contents", async () => {
    const r = await query(client, sessionId, '{ t | uses("Item", t) }');
    const sc = r.structuredContent as { rows: { t: string }[] };
    expect(new Set(sc.rows.map((row) => row.t))).toEqual(
      new Set(["Presentable", "Relocatable"]),
    );
  });

  it("/^Can/ relations restricted to prelude layer", async () => {
    const r = await query(
      client,
      sessionId,
      "{ r : Relation@prelude | r.id =~ /^Can/ }",
    );
    const sc = r.structuredContent as { rows: { r: string }[] };
    expect(new Set(sc.rows.map((row) => row.r))).toEqual(new Set(["CanTouch", "CanSee"]));
  });

  it("yes/no satisfied returns count=1 with empty row", async () => {
    const r = await query(
      client,
      sessionId,
      '?- exists r : Relation. r.id = "IsPlayer"',
    );
    const sc = r.structuredContent as { count: number; head: string[] };
    expect(sc.count).toBe(1);
    expect(sc.head).toEqual([]);
  });

  it("yes/no unsatisfied returns count=0", async () => {
    const r = await query(
      client,
      sessionId,
      '?- exists r : Relation. r.id = "DoesNotExist"',
    );
    const sc = r.structuredContent as { count: number };
    expect(sc.count).toBe(0);
  });

  it("composes meta + scope: Kind ids whose layer is prelude", async () => {
    const r = await query(client, sessionId, "{ k : Kind@prelude | true }");
    const sc = r.structuredContent as { rows: { k: string }[] };
    expect(new Set(sc.rows.map((row) => row.k))).toEqual(
      new Set(["Thing", "Place", "Person", "Item"]),
    );
  });
});

describe("MCP server: layer attribution", () => {
  let client: Client;
  let close: () => Promise<void>;
  let sessionId: string;
  beforeAll(async () => {
    const c = await startClient();
    client = c.client;
    close = c.close;
    sessionId = await start(client);
  });
  afterAll(async () => {
    await close();
  });

  it("Trait@game returns nothing when no story is loaded", async () => {
    const r = await query(client, sessionId, "{ t : Trait@game | true }");
    expect((r.structuredContent as { count: number }).count).toBe(0);
  });

  it("Trait@session also returns nothing", async () => {
    const r = await query(client, sessionId, "{ t : Trait@session | true }");
    expect((r.structuredContent as { count: number }).count).toBe(0);
  });

  it("Trait@prelude has all 10 traits", async () => {
    const r = await query(client, sessionId, "{ t : Trait@prelude | true }");
    expect((r.structuredContent as { count: number }).count).toBe(10);
  });
});

describe("MCP server: error surfaces", () => {
  let client: Client;
  let close: () => Promise<void>;
  let sessionId: string;
  beforeAll(async () => {
    const c = await startClient();
    client = c.client;
    close = c.close;
    sessionId = await start(client);
  });
  afterAll(async () => {
    await close();
  });

  it("parse error: malformed DSL surfaces with category=parse", async () => {
    const r = await query(client, sessionId, "?- @bad");
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/^\[parse\]/);
  });

  it("evaluate error: reference to unknown relation surfaces with category=evaluate", async () => {
    const r = await query(client, sessionId, "?- Ghost(x)");
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/^\[evaluate\]/);
    expect(r.content?.[0]?.text).toMatch(/unknown relation 'Ghost'/);
  });
});

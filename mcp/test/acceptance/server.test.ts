import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, "../../../..");
const TUTORIAL_PATH = resolve(REPO_ROOT, "stories/tutorial/tutorial.qualms");
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
    args: [CLI_PATH],
    cwd: REPO_ROOT,
  });
  const client = new Client({ name: "qualms-acceptance", version: "0.0.1" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

describe("MCP server for the current Qualms DSL", () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ client, close } = await startClient());
  });

  afterAll(async () => {
    await close();
  });

  it("lists the supported current-DSL tool set", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "begin",
      "commit",
      "diff",
      "mutate",
      "play",
      "query",
      "quit",
      "rollback",
      "start",
    ]);
  });

  it("starts without a prelude or YAML core path", async () => {
    const result = await call(client, "start", { storyPaths: [TUTORIAL_PATH] });
    expect(result.isError).not.toBe(true);
    const content = result.structuredContent as {
      sessionId: string;
      loaded: { counts: Record<string, number>; storyPaths: string[] };
    };
    expect(content.sessionId).toMatch(/[0-9a-f-]+/);
    expect(content.loaded.storyPaths).toEqual([TUTORIAL_PATH]);
    expect(content.loaded.counts.traits).toBe(8);
    expect(content.loaded.counts.actions).toBe(8);
  });

  it("queries using the current DSL expression syntax", async () => {
    const start = await call(client, "start", { storyPaths: [TUTORIAL_PATH] });
    const sessionId = (start.structuredContent as { sessionId: string }).sessionId;
    const result = await call(client, "query", {
      sessionId,
      expr: "LockedWith(Bars, key)",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      kind: "query",
      rows: [{ key: "MasterKey" }],
      count: 1,
    });
  });

  it("reports missing story paths as tool errors", async () => {
    const result = await call(client, "start", {
      storyPaths: ["/totally/missing/story.qualms"],
    });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/ENOENT|no such file/i);
  });

  it("quits sessions", async () => {
    const start = await call(client, "start", {});
    const sessionId = (start.structuredContent as { sessionId: string }).sessionId;
    const first = await call(client, "quit", { sessionId });
    expect(first.structuredContent).toEqual({ ok: true });
    const second = await call(client, "quit", { sessionId });
    expect(second.structuredContent).toEqual({ ok: false });
  });
});

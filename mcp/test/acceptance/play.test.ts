import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  const client = new Client({ name: "qualms-play-acceptance", version: "0.0.1" });
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

describe("MCP play with tutorial-syntax stories", () => {
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ client, close } = await startClient());
  });

  afterAll(async () => {
    await close();
  });

  it("runs the lock/open/move tutorial flow through the play tool", async () => {
    const start = await call(client, "start", { storyPaths: [TUTORIAL_PATH] });
    const sessionId = (start.structuredContent as { sessionId: string }).sessionId;

    expect(
      (await call(client, "play", { sessionId, call: "Open(Player, Bars)" })).structuredContent,
    ).toMatchObject({
      status: "failed",
      feedback: "fail { Locked(Bars); }",
    });
    expect(
      (await call(client, "play", {
        sessionId,
        call: "Unlock(Player, Bars, MasterKey)",
      })).structuredContent,
    ).toMatchObject({ status: "passed", feedback: "succeed;" });
    expect(
      (await call(client, "play", { sessionId, call: "Open(Player, Bars)" })).structuredContent,
    ).toMatchObject({ status: "passed", feedback: "succeed;" });
    expect(
      (await call(client, "play", { sessionId, call: "Go(Player, Corridor)" })).structuredContent,
    ).toMatchObject({ status: "passed", feedback: "succeed;" });

    const query = await call(client, "query", { sessionId, expr: "At(Player, here)" });
    expect(query.structuredContent).toMatchObject({
      kind: "query",
      rows: [{ here: "Corridor" }],
    });
  });

  it("mutates an arbitrary current-syntax story and persists normalized .qualms on commit", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "qualms-mcp-acceptance-"));
    const targetPath = join(tmpDir, "story.qualms");
    try {
      const start = await call(client, "start", {});
      const sessionId = (start.structuredContent as { sessionId: string }).sessionId;
      const begin = await call(client, "begin", { sessionId, targetPath });
      const transactionId = (begin.structuredContent as { transactionId: string }).transactionId;

      const mutate = await call(client, "mutate", {
        sessionId,
        transactionId,
        expr: `
          trait Actor
          trait Location
          relation At(Actor, one Location)
          entity Player { Actor }
          entity Room { Location }
          set At(Player, Room)
        `,
      });
      expect(mutate.isError).not.toBe(true);

      const query = await call(client, "query", { sessionId, expr: "At(Player, place)" });
      expect(query.structuredContent).toMatchObject({
        kind: "query",
        rows: [{ place: "Room" }],
      });

      const commit = await call(client, "commit", { sessionId, transactionId });
      expect(commit.structuredContent).toMatchObject({
        committed: 1,
        persisted: true,
        targetPath,
      });
      expect(readFileSync(targetPath, "utf-8")).toContain("relation At(Actor, one Location)");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

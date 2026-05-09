/**
 * Acceptance tests for the `play` MCP tool. Each test spawns qualms-mcp,
 * mutates a small story, then plays actions and queries to verify state.
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
  const client = new Client({ name: "qualms-play-acceptance", version: "0.0.1" });
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

describe("play acceptance: prelude actions", () => {
  let client: Client;
  let close: () => Promise<void>;
  let sessionId: string;
  beforeAll(async () => {
    ({ client, close } = await startClient());
    sessionId = await start(client);
    // Set up: a place, a player, an item, all asserted. `At` is derived from
    // `Relocatable.location`, so we set the field directly rather than going
    // through `assert At(...)` (which the mutation tool doesn't expand yet).
    const begin = await call(client, "begin", { sessionId, module: "session" });
    const tx = (begin.structuredContent as { transactionId: string }).transactionId;
    const r = await call(client, "mutate", {
      sessionId,
      transactionId: tx,
      expr: `
        def entity here: Place;
        def entity rock: Item;
        def entity player: Person;
        assert IsPlayer(player);
        player.location := here;
        rock.location := here;
      `,
    });
    expect(r.isError).not.toBe(true);
    await call(client, "commit", { sessionId, transactionId: tx });
  });
  afterAll(async () => {
    await close();
  });

  it("Examine emits the target's description", async () => {
    // Set rock's description so Examine has something to emit.
    const begin = await call(client, "begin", { sessionId, module: "session" });
    const tx = (begin.structuredContent as { transactionId: string }).transactionId;
    await call(client, "mutate", {
      sessionId,
      transactionId: tx,
      expr: 'rock.Presentable.description := "A small grey stone.";',
    });
    await call(client, "commit", { sessionId, transactionId: tx });

    const r = await call(client, "play", {
      sessionId,
      action: "Examine",
      args: { actor: "player", target: "rock" },
    });
    expect(r.isError).not.toBe(true);
    const sc = r.structuredContent as { events: { text: string }[] };
    expect(sc.events).toEqual([{ text: "A small grey stone." }]);
  });

  it("Take asserts CarriedBy when the actor can touch the item", async () => {
    // Ensure the item is at the same place as the player (set up in beforeAll).
    const r = await call(client, "play", {
      sessionId,
      action: "Take",
      args: { actor: "player", item: "rock" },
    });
    expect(r.isError).not.toBe(true);

    // Verify via query that CarriedBy(player, rock) holds.
    const q = await call(client, "query", {
      sessionId,
      expr: 'exists { CarriedBy("player", "rock") };',
    });
    const qsc = q.structuredContent as { statements: { kind: string; result: boolean }[] };
    expect(qsc.statements[0]).toMatchObject({ kind: "exists", result: true });
  });

  it("Take rejects when CanTouch fails (different location)", async () => {
    // Place gem somewhere the player can't reach.
    const begin = await call(client, "begin", { sessionId, module: "session" });
    const tx = (begin.structuredContent as { transactionId: string }).transactionId;
    await call(client, "mutate", {
      sessionId,
      transactionId: tx,
      expr: `
        def entity faraway: Place;
        def entity gem: Item;
        gem.location := faraway;
      `,
    });
    await call(client, "commit", { sessionId, transactionId: tx });

    const r = await call(client, "play", {
      sessionId,
      action: "Take",
      args: { actor: "player", item: "gem" },
    });
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/requires_failed/);
  });

  it("unknown action returns a play-error", async () => {
    const r = await call(client, "play", {
      sessionId,
      action: "Nope",
      args: {},
    });
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/unknown_action/);
  });

  it("missing required arg returns a play-error", async () => {
    const r = await call(client, "play", {
      sessionId,
      action: "Take",
      args: { actor: "player" }, // missing `item`
    });
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/missing_arg/);
  });
});

describe("play acceptance: iterative mutate-and-play loop", () => {
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

  it("user-defined action runs end-to-end", async () => {
    // Define a simple Score trait + IncrementScore action.
    const begin = await call(client, "begin", { sessionId, module: "session" });
    const tx = (begin.structuredContent as { transactionId: string }).transactionId;
    await call(client, "mutate", {
      sessionId,
      transactionId: tx,
      expr: `
        def trait Scored { score: int = 0 };
        def kind Player: Scored;
        def entity p1: Player;
        def action IncrementScore(target: Scored, by: int) {
          effects: [ target.score := by ];
        };
      `,
    });
    await call(client, "commit", { sessionId, transactionId: tx });

    // Play the action.
    const r = await call(client, "play", {
      sessionId,
      action: "IncrementScore",
      args: { target: "p1", by: 7 },
    });
    expect(r.isError).not.toBe(true);

    // Verify via query — string-literal entity id binds the field-term head.
    const q = await call(client, "query", {
      sessionId,
      expr: 'query { v | "p1".Scored.score = v };',
    });
    if (q.isError) throw new Error(`query failed: ${q.content?.[0]?.text}`);
    const qsc = q.structuredContent as {
      statements: { rows: { v: number }[] }[];
    };
    expect(qsc.statements[0]?.rows[0]?.v).toBe(7);
  });
});

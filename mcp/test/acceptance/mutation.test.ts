/**
 * Subprocess-driven acceptance tests for the structural mutation tools
 * (__begin, __mutate, __diff, __commit, __rollback). Spawns the qualms-mcp
 * server as a child process, drives it via the official MCP client over
 * stdio, and asserts on responses end-to-end.
 *
 * Three scenarios:
 *   1. Rollback path (session scope) — mutations apply, queries see them, rollback discards.
 *   2. Commit path (story scope) — mutations apply, commit writes YAML to disk, reload succeeds.
 *   3. Error surfaces — unknown tx, prelude protection, parse errors, mutate without tx.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GameDefinition, yaml as yamlNs } from "@quealm/qualms";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(__filename, "../../../..");
const PRELUDE_PATH = resolve(REPO_ROOT, "qualms/prelude/core.qualms.yaml");
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
  const client = new Client({ name: "qualms-mutation-acceptance", version: "0.0.1" });
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

describe("acceptance: rollback path (session scope)", () => {
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

  it("end-to-end: begin → mutate → query → diff → rollback → query", async () => {
    // Begin a session-scope transaction.
    const begin = await call(client, "begin", { sessionId, scope: "session" });
    expect(begin.isError).not.toBe(true);
    const transactionId = (begin.structuredContent as { transactionId: string }).transactionId;

    // Apply a few structural mutations.
    for (const expr of [
      "def trait Combatant { fields: { hp: { default: 10 } } }",
      "def kind Foe { traits: [Combatant, Presentable] }",
      'def entity grunt : Foe { fields: { Presentable: { name: "Grunt" } } }',
    ]) {
      const r = await call(client, "mutate", { sessionId, transactionId, expr });
      expect(r.isError).not.toBe(true);
    }

    // Query mid-transaction sees the new entity.
    const q1 = await call(client, "query", {
      sessionId,
      expr: '{ e : Entity | e.id = "grunt" }',
    });
    expect((q1.structuredContent as { count: number }).count).toBe(1);

    // Diff lists the applied mutations + summary counts.
    const diff = await call(client, "diff", { sessionId, transactionId });
    const dsc = diff.structuredContent as {
      applied: { kind: string }[];
      summary: { traits: { added: number }; kinds: { added: number }; entities: { added: number } };
    };
    expect(dsc.applied.map((a) => a.kind)).toEqual(["defTrait", "defKind", "defEntity"]);
    expect(dsc.summary.traits.added).toBe(1);
    expect(dsc.summary.kinds.added).toBe(1);
    expect(dsc.summary.entities.added).toBe(1);

    // Rollback discards.
    const rb = await call(client, "rollback", { sessionId, transactionId });
    expect((rb.structuredContent as { discarded: number }).discarded).toBe(3);

    // Post-rollback the entity is gone.
    const q2 = await call(client, "query", {
      sessionId,
      expr: '{ e : Entity | e.id = "grunt" }',
    });
    expect((q2.structuredContent as { count: number }).count).toBe(0);
  });
});

describe("acceptance: commit path (story scope, disk write)", () => {
  let client: Client;
  let close: () => Promise<void>;
  let sessionId: string;
  const tmpDir = mkdtempSync(join(tmpdir(), "qualms-acceptance-"));
  const targetPath = join(tmpDir, "scratch.qualms.yaml");

  beforeAll(async () => {
    ({ client, close } = await startClient());
    sessionId = await start(client);
  });
  afterAll(async () => {
    await close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("end-to-end: begin(story) → mutate → commit → re-load YAML proves persistence", async () => {
    const begin = await call(client, "begin", {
      sessionId,
      scope: "story",
      targetPath,
    });
    expect(begin.isError).not.toBe(true);
    const transactionId = (begin.structuredContent as { transactionId: string }).transactionId;

    for (const expr of [
      "def trait Combatant { fields: { hp: { default: 10 } } }",
      "def kind Foe { traits: [Combatant, Presentable] }",
      'def entity grunt : Foe { fields: { Presentable: { name: "Grunt" } } }',
    ]) {
      const r = await call(client, "mutate", { sessionId, transactionId, expr });
      expect(r.isError).not.toBe(true);
    }

    const commit = await call(client, "commit", { sessionId, transactionId });
    expect(commit.isError).not.toBe(true);
    const csc = commit.structuredContent as {
      committed: number;
      persisted: boolean;
      targetPath: string;
    };
    expect(csc.persisted).toBe(true);
    expect(csc.targetPath).toBe(targetPath);
    expect(csc.committed).toBe(3);

    // Independently re-load the YAML on top of a fresh prelude — the structural
    // additions must round-trip cleanly through the file.
    const fresh = new GameDefinition();
    yamlNs.loadFileIntoDefinition(fresh, PRELUDE_PATH, "prelude");
    yamlNs.loadFileIntoDefinition(fresh, targetPath, "game");
    expect(fresh.hasTrait("Combatant")).toBe(true);
    expect(fresh.hasKind("Foe")).toBe(true);
    expect(fresh.initialEntities.find((e) => e.id === "grunt")?.kind).toBe("Foe");
  });
});

describe("acceptance: error surfaces", () => {
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

  it("__mutate without an open transaction returns isError", async () => {
    const r = await call(client, "mutate", {
      sessionId,
      transactionId: "no-such-tx",
      expr: "def trait X {}",
    });
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/no open transaction/);
  });

  it("__begin a second time on an open tx returns isError", async () => {
    const begin1 = await call(client, "begin", { sessionId, scope: "session" });
    expect(begin1.isError).not.toBe(true);
    const begin2 = await call(client, "begin", { sessionId, scope: "session" });
    expect(begin2.isError).toBe(true);
    expect(begin2.content?.[0]?.text).toMatch(/already has an open transaction/);
    // Clean up: rollback so other tests in this block can __begin.
    const tx1 = (begin1.structuredContent as { transactionId: string }).transactionId;
    await call(client, "rollback", { sessionId, transactionId: tx1 });
  });

  it("undef of a prelude trait returns prelude_protected", async () => {
    const begin = await call(client, "begin", { sessionId, scope: "session" });
    const tx = (begin.structuredContent as { transactionId: string }).transactionId;
    const r = await call(client, "mutate", {
      sessionId,
      transactionId: tx,
      expr: "undef trait Presentable",
    });
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/prelude_protected/);
    await call(client, "rollback", { sessionId, transactionId: tx });
  });

  it("a parse error in __mutate returns category=parse", async () => {
    const begin = await call(client, "begin", { sessionId, scope: "session" });
    const tx = (begin.structuredContent as { transactionId: string }).transactionId;
    const r = await call(client, "mutate", {
      sessionId,
      transactionId: tx,
      expr: "def trait", // malformed
    });
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/\[parse\]/);
    await call(client, "rollback", { sessionId, transactionId: tx });
  });

  it("story-scope __begin without targetPath errors when no story files loaded", async () => {
    const r = await call(client, "begin", { sessionId, scope: "story" });
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toMatch(/targetPath/);
  });
});

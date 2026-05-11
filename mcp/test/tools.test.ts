import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { SessionManager, TransactionAlreadyOpenError } from "../src/session.js";
import {
  MutationError,
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
} from "../src/tools.js";

const __filename = fileURLToPath(import.meta.url);
const TUTORIAL_PATH = resolve(__filename, "../../../stories/tutorial/tutorial.qualms");

describe("tool handlers for the tutorial-era DSL", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it("starts a session from any current-syntax .qualms file", () => {
    const out = handleStart(manager, { storyPaths: [TUTORIAL_PATH] });
    expect(out.sessionId).toMatch(/[0-9a-f-]{8,}/);
    expect(out.loaded.storyPaths).toEqual([TUTORIAL_PATH]);
    expect(out.loaded.counts).toMatchObject({
      traits: 10,
      relations: 12,
      predicates: 3,
      actions: 10,
      entities: 19,
    });
  });

  it("queries facts, definitions, and expression patterns", () => {
    const sessionId = handleStart(manager, { storyPaths: [TUTORIAL_PATH] }).sessionId;

    const summary = handleQuery(manager, { sessionId });
    expect(summary.kind).toBe("summary");
    if (summary.kind !== "summary") throw new Error("expected summary");
    expect(summary.facts.some((fact) => fact.text === "Locked(Bars)")).toBe(true);

    const show = handleQuery(manager, { sessionId, expr: "show action Open" });
    expect(show.kind).toBe("show");
    if (show.kind !== "show") throw new Error("expected show");
    expect(show.definitions[0]).toContain("action Open");

    const query = handleQuery(manager, { sessionId, expr: "LockedWith(Bars, key)" });
    expect(query.kind).toBe("query");
    if (query.kind !== "query") throw new Error("expected query");
    expect(query.rows).toEqual([{ key: "MasterKey" }]);
  });

  it("plays calls and returns compact DSL feedback", () => {
    const sessionId = handleStart(manager, { storyPaths: [TUTORIAL_PATH] }).sessionId;

    expect(handlePlay(manager, { sessionId, call: "Open(Player, Bars)" })).toMatchObject({
      status: "failed",
      feedback: "fail { Locked(Bars); }",
    });
    expect(handlePlay(manager, { sessionId, call: "Unlock(Player, Bars, MasterKey)" })).toMatchObject({
      status: "passed",
      feedback: "succeed;",
    });
    expect(handlePlay(manager, { sessionId, call: "Open(Player, Bars)" })).toMatchObject({
      status: "passed",
      feedback: "succeed;",
    });
    expect(handlePlay(manager, { sessionId, call: "Go(Player, Corridor)" })).toMatchObject({
      status: "passed",
      feedback: "succeed;",
    });

    const at = handleQuery(manager, { sessionId, expr: "At(Player, here)" });
    expect(at.kind).toBe("query");
    if (at.kind !== "query") throw new Error("expected query");
    expect(at.rows).toEqual([{ here: "Corridor" }]);
  });

  it("mutates arbitrary current-syntax story fragments inside transactions", () => {
    const sessionId = handleStart(manager).sessionId;
    const tx = handleBegin(manager, { sessionId });
    expect(tx.transactionId).toMatch(/[0-9a-f-]{8,}/);

    const out = handleMutate(manager, {
      sessionId,
      transactionId: tx.transactionId,
      expr: `
        trait Flag
        relation Lit(Flag)
        entity Torch { Flag }
        set Lit(Torch)
      `,
    });
    expect(out.counts).toMatchObject({ traits: 1, relations: 1, entities: 1, facts: 1 });
    expect(handleQuery(manager, { sessionId, expr: "Lit(Torch)" })).toMatchObject({
      kind: "query",
      count: 1,
    });

    const diff = handleDiff(manager, { sessionId, transactionId: tx.transactionId });
    expect(diff.applied).toHaveLength(1);
    expect(diff.counts.before.facts).toBe(0);
    expect(diff.counts.after.facts).toBe(1);
  });

  it("rolls back and commits transaction snapshots", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "qualms-mcp-tools-"));
    const targetPath = join(tmpDir, "story.qualms");
    try {
      const sessionId = handleStart(manager).sessionId;
      const rollbackTx = handleBegin(manager, { sessionId });
      handleMutate(manager, {
        sessionId,
        transactionId: rollbackTx.transactionId,
        expr: "trait Gone",
      });
      expect(handleRollback(manager, { sessionId, transactionId: rollbackTx.transactionId })).toEqual({
        discarded: 1,
      });
      expect(handleQuery(manager, { sessionId, expr: "show trait Gone" })).toMatchObject({
        kind: "show",
        count: 0,
      });

      const commitTx = handleBegin(manager, { sessionId, targetPath });
      handleMutate(manager, {
        sessionId,
        transactionId: commitTx.transactionId,
        expr: "trait Kept",
      });
      expect(handleCommit(manager, { sessionId, transactionId: commitTx.transactionId })).toEqual({
        committed: 1,
        persisted: true,
        targetPath,
      });
      expect(readFileSync(targetPath, "utf-8")).toContain("trait Kept");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects second transactions and parse errors", () => {
    const sessionId = handleStart(manager).sessionId;
    handleBegin(manager, { sessionId });
    expect(() => handleBegin(manager, { sessionId })).toThrowError(TransactionAlreadyOpenError);
    expect(() => handleQuery(manager, { sessionId, expr: "@bad" })).toThrowError(QueryError);
    expect(() =>
      handleMutate(manager, { sessionId, transactionId: "bad", expr: "trait A" }),
    ).toThrow();
  });

  it("surfaces mutation parse errors with the new parser", () => {
    const sessionId = handleStart(manager).sessionId;
    const tx = handleBegin(manager, { sessionId });
    expect(() =>
      handleMutate(manager, {
        sessionId,
        transactionId: tx.transactionId,
        expr: "trait",
      }),
    ).toThrowError(MutationError);
  });
});

describe("server wiring", () => {
  it("registers without requiring a legacy prelude", () => {
    const built = buildServer();
    expect(built.server).toBeDefined();
    expect(built.manager).toBeInstanceOf(SessionManager);
  });
});

describe("quit", () => {
  it("removes known sessions and reports false for unknown sessions", () => {
    const manager = new SessionManager();
    const sessionId = handleStart(manager).sessionId;
    expect(handleQuit(manager, { sessionId })).toEqual({ ok: true });
    expect(handleQuit(manager, { sessionId })).toEqual({ ok: false });
  });
});

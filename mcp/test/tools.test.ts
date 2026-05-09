import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GameDefinition, yaml as yamlNs } from "@quealm/qualms";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

const { loadYamlIntoDefinition } = yamlNs;
import {
  MutationError,
  QueryError,
  handleBegin,
  handleCommit,
  handleDiff,
  handleMutate,
  handleQuery,
  handleQuit,
  handleRollback,
  handleStart,
} from "../src/tools.js";
import {
  SessionManager,
  SessionNotFoundError,
  TransactionAlreadyOpenError,
  TransactionNotFoundError,
} from "../src/session.js";

const __filename = fileURLToPath(import.meta.url);
const PRELUDE_PATH = resolve(__filename, "../../../qualms/prelude/core.qualms.yaml");

describe("tool handler: __start", () => {
  let mgr: SessionManager;
  beforeEach(() => {
    mgr = new SessionManager();
  });

  it("rejects missing corePath", () => {
    expect(() => handleStart(mgr, { corePath: "" })).toThrowError(/corePath/);
  });

  it("loads the core prelude and reports counts", () => {
    const out = handleStart(mgr, { corePath: PRELUDE_PATH });
    expect(out.sessionId).toMatch(/[0-9a-f-]{8,}/);
    expect(out.loaded.corePath).toBe(PRELUDE_PATH);
    expect(out.loaded.storyPaths).toEqual([]);
    // Migrated prelude has 4 kinds (Thing, Place, Person, Item).
    expect(out.loaded.counts.kinds).toBe(4);
    // 10 traits (Presentable, Actor, Location, Relocatable, Scope, Container, Portable, Usable, Equipment, Ownable)
    expect(out.loaded.counts.traits).toBe(10);
    expect(mgr.size()).toBe(1);
  });

  it("propagates a YAML load failure as an Error", () => {
    expect(() => handleStart(mgr, { corePath: "/nope/missing.yaml" })).toThrow();
  });
});

describe("tool handler: __quit", () => {
  let mgr: SessionManager;
  beforeEach(() => {
    mgr = new SessionManager();
  });

  it("returns ok=true when removing a known session", () => {
    const start = handleStart(mgr, { corePath: PRELUDE_PATH });
    const out = handleQuit(mgr, { sessionId: start.sessionId });
    expect(out.ok).toBe(true);
    expect(mgr.has(start.sessionId)).toBe(false);
  });

  it("returns ok=false for an unknown session id", () => {
    expect(handleQuit(mgr, { sessionId: "unknown" })).toEqual({ ok: false });
  });
});

describe("tool handler: __query", () => {
  let mgr: SessionManager;
  let sessionId: string;
  beforeEach(() => {
    mgr = new SessionManager();
    const out = handleStart(mgr, { corePath: PRELUDE_PATH });
    sessionId = out.sessionId;
  });

  it("comprehension over Kinds with Presentable returns four", () => {
    const out = handleQuery(mgr, {
      sessionId,
      expr: '{ k : Kind | uses(k, "Presentable") }',
    });
    expect(out.head).toEqual(["k"]);
    expect(out.count).toBe(4);
    const ks = new Set(out.rows.map((r) => r["k"]));
    expect(ks).toEqual(new Set(["Thing", "Place", "Person", "Item"]));
  });

  it("?- yes/no returns count=1 when satisfied", () => {
    const out = handleQuery(mgr, {
      sessionId,
      expr: '?- exists r : Relation. r.id = "IsPlayer"',
    });
    expect(out.head).toEqual([]);
    expect(out.count).toBe(1);
  });

  it("?- yes/no returns count=0 when not satisfied", () => {
    const out = handleQuery(mgr, {
      sessionId,
      expr: '?- exists r : Relation. r.id = "DoesNotExist"',
    });
    expect(out.count).toBe(0);
  });

  it("regex over @prelude relations matching ^Can", () => {
    const out = handleQuery(mgr, {
      sessionId,
      expr: "{ r : Relation@prelude | r.id =~ /^Can/ }",
    });
    const rs = new Set(out.rows.map((r) => r["r"]));
    expect(rs).toEqual(new Set(["CanTouch", "CanSee"]));
  });

  it("rejects an unknown session id with SessionNotFoundError", () => {
    expect(() => handleQuery(mgr, { sessionId: "ghost", expr: "?- true" })).toThrowError(
      SessionNotFoundError,
    );
  });

  it("classifies parse errors with category=parse and a span", () => {
    try {
      handleQuery(mgr, { sessionId, expr: "?- @bad" });
      expect.unreachable("expected QueryError");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).category).toBe("parse");
    }
  });

  it("classifies evaluator errors with category=evaluate", () => {
    try {
      handleQuery(mgr, { sessionId, expr: "?- Ghost(x)" });
      expect.unreachable("expected QueryError");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).category).toBe("evaluate");
    }
  });
});

// ──────── Pipeline test through the buildServer entry point ────────

describe("buildServer wiring (no transport, just registration)", () => {
  it("registers tools without throwing", async () => {
    const { buildServer } = await import("../src/server.js");
    const built = buildServer();
    expect(built.server).toBeDefined();
    expect(built.manager).toBeInstanceOf(SessionManager);
  });
});

// ──────── Mutation tools ────────

describe("tool handler: __begin / __mutate / __diff / __commit / __rollback", () => {
  let mgr: SessionManager;
  let sessionId: string;
  const tmpFiles: string[] = [];
  const tmpDir = mkdtempSync(join(tmpdir(), "qualms-tools-test-"));

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mgr = new SessionManager();
    sessionId = handleStart(mgr, { corePath: PRELUDE_PATH }).sessionId;
  });

  it("begin opens a session-module transaction", () => {
    const out = handleBegin(mgr, { sessionId, module: "session" });
    expect(out.module).toBe("session");
    expect(out.transactionId).toMatch(/[0-9a-f-]{8,}/);
  });

  it("begin rejects module: prelude with prelude_protected", () => {
    expect(() =>
      handleBegin(mgr, { sessionId, module: "prelude" as never }),
    ).toThrowError(MutationError);
  });

  it("__begin rejects a second open transaction in the same session", () => {
    handleBegin(mgr, { sessionId, module: "session" });
    expect(() => handleBegin(mgr, { sessionId, module: "session" })).toThrowError(
      TransactionAlreadyOpenError,
    );
  });

  it("__begin story scope without targetPath fails when no story files loaded", () => {
    expect(() => handleBegin(mgr, { sessionId, module: "game" })).toThrowError(MutationError);
  });

  it("__mutate inside a transaction lets __query see pending changes", () => {
    const tx = handleBegin(mgr, { sessionId, module: "session" });
    handleMutate(mgr, {
      sessionId,
      transactionId: tx.transactionId,
      expr: "def trait NewTrait {}",
    });
    const out = handleQuery(mgr, {
      sessionId,
      expr: '?- exists T : Trait. T.id = "NewTrait"',
    });
    expect(out.count).toBe(1);
  });

  it("__diff reports applied mutations and summary counts", () => {
    const tx = handleBegin(mgr, { sessionId, module: "session" });
    handleMutate(mgr, { sessionId, transactionId: tx.transactionId, expr: "def trait A {}" });
    handleMutate(mgr, { sessionId, transactionId: tx.transactionId, expr: "def trait B {}" });
    const diff = handleDiff(mgr, { sessionId, transactionId: tx.transactionId });
    expect(diff.applied.map((a) => a.kind)).toEqual(["defTrait", "defTrait"]);
    expect(diff.summary.traits.added).toBe(2);
    expect(diff.summary.traits.removed).toBe(0);
  });

  it("__rollback discards pending changes and clears the transaction", () => {
    const tx = handleBegin(mgr, { sessionId, module: "session" });
    handleMutate(mgr, {
      sessionId,
      transactionId: tx.transactionId,
      expr: "def trait Tossed {}",
    });
    expect(
      handleQuery(mgr, { sessionId, expr: '?- exists T : Trait. T.id = "Tossed"' }).count,
    ).toBe(1);
    const out = handleRollback(mgr, { sessionId, transactionId: tx.transactionId });
    expect(out.discarded).toBe(1);
    expect(
      handleQuery(mgr, { sessionId, expr: '?- exists T : Trait. T.id = "Tossed"' }).count,
    ).toBe(0);
    expect(mgr.get(sessionId).transaction).toBe(null);
    // A fresh __begin works after rollback.
    expect(handleBegin(mgr, { sessionId, module: "session" }).transactionId).toBeDefined();
  });

  it("__commit session-scope retains changes in memory only", () => {
    const tx = handleBegin(mgr, { sessionId, module: "session" });
    handleMutate(mgr, {
      sessionId,
      transactionId: tx.transactionId,
      expr: "def trait Kept {}",
    });
    const out = handleCommit(mgr, { sessionId, transactionId: tx.transactionId });
    expect(out.persisted).toBe(false);
    expect(out.reason).toBe("session-save-deferred");
    expect(out.committed).toBe(1);
    expect(
      handleQuery(mgr, { sessionId, expr: '?- exists T : Trait. T.id = "Kept"' }).count,
    ).toBe(1);
    expect(mgr.get(sessionId).transaction).toBe(null);
  });

  it("__commit story-scope writes a YAML file the loader can re-read", () => {
    const targetPath = join(tmpDir, "scratch.qualms.yaml");
    tmpFiles.push(targetPath);
    const tx = handleBegin(mgr, { sessionId, module: "game", targetPath });
    handleMutate(mgr, {
      sessionId,
      transactionId: tx.transactionId,
      expr: 'def trait Combatant { fields: { hp: { default: 10 } } }',
    });
    handleMutate(mgr, {
      sessionId,
      transactionId: tx.transactionId,
      expr: "def kind Foe { traits: [Combatant, Presentable] }",
    });
    handleMutate(mgr, {
      sessionId,
      transactionId: tx.transactionId,
      expr: 'def entity grunt : Foe { fields: { Presentable: { name: "Grunt" } } }',
    });
    const out = handleCommit(mgr, { sessionId, transactionId: tx.transactionId });
    expect(out.persisted).toBe(true);
    expect(out.targetPath).toBe(targetPath);
    expect(out.committed).toBe(3);

    // Read the file back and confirm the structure round-trips through the loader.
    const yamlText = readFileSync(targetPath, "utf-8");
    const reloaded = new GameDefinition();
    // Pre-load the prelude so trait references on the kind resolve.
    yamlNs.loadFileIntoDefinition(reloaded, PRELUDE_PATH, "prelude");
    loadYamlIntoDefinition(reloaded, yamlText, { module: "game" });
    expect(reloaded.hasTrait("Combatant")).toBe(true);
    expect(reloaded.hasKind("Foe")).toBe(true);
    expect(reloaded.initialEntities.find((e) => e.id === "grunt")?.kind).toBe("Foe");
  });

  it("__mutate without an open transaction errors", () => {
    expect(() =>
      handleMutate(mgr, { sessionId, transactionId: "nope", expr: "def trait X {}" }),
    ).toThrowError(TransactionNotFoundError);
  });

  it("__diff / __commit / __rollback with a wrong transaction id error", () => {
    handleBegin(mgr, { sessionId, module: "session" });
    expect(() => handleDiff(mgr, { sessionId, transactionId: "wrong" })).toThrowError(
      TransactionNotFoundError,
    );
    expect(() => handleCommit(mgr, { sessionId, transactionId: "wrong" })).toThrowError(
      TransactionNotFoundError,
    );
    expect(() => handleRollback(mgr, { sessionId, transactionId: "wrong" })).toThrowError(
      TransactionNotFoundError,
    );
  });

  it("__mutate parse error surfaces as QueryError(parse)", () => {
    const tx = handleBegin(mgr, { sessionId, module: "session" });
    try {
      handleMutate(mgr, {
        sessionId,
        transactionId: tx.transactionId,
        expr: "def trait", // malformed
      });
      expect.unreachable("expected QueryError");
    } catch (err) {
      expect(err).toBeInstanceOf(QueryError);
      expect((err as QueryError).category).toBe("parse");
    }
  });

  it("__mutate prelude-protected errors with category=prelude_protected", () => {
    const tx = handleBegin(mgr, { sessionId, module: "session" });
    try {
      handleMutate(mgr, {
        sessionId,
        transactionId: tx.transactionId,
        expr: "undef trait Presentable",
      });
      expect.unreachable("expected MutationError");
    } catch (err) {
      expect(err).toBeInstanceOf(MutationError);
      expect((err as InstanceType<typeof MutationError>).category).toBe("prelude_protected");
    }
  });

  it("cross-session isolation: mutating in one session does not affect another", () => {
    const sessionB = handleStart(mgr, { corePath: PRELUDE_PATH }).sessionId;
    const txA = handleBegin(mgr, { sessionId, module: "session" });
    handleMutate(mgr, {
      sessionId,
      transactionId: txA.transactionId,
      expr: "def trait OnlyA {}",
    });
    const inB = handleQuery(mgr, {
      sessionId: sessionB,
      expr: '?- exists T : Trait. T.id = "OnlyA"',
    });
    expect(inB.count).toBe(0);
  });

  it("__quit during an open transaction releases the session cleanly", () => {
    const tx = handleBegin(mgr, { sessionId, module: "session" });
    handleMutate(mgr, { sessionId, transactionId: tx.transactionId, expr: "def trait T {}" });
    const out = handleQuit(mgr, { sessionId });
    expect(out.ok).toBe(true);
    expect(mgr.has(sessionId)).toBe(false);
  });
});

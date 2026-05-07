import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  QueryError,
  handleQuery,
  handleQuit,
  handleStart,
} from "../src/tools.js";
import { SessionManager, SessionNotFoundError } from "../src/session.js";

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

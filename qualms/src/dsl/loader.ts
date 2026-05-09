/**
 * `.qualms` file format loader. Parses a sequence of DSL v2 `def` statements
 * and applies each to a `GameDefinition` at the file's module attribution.
 *
 * Rejects non-file-scope statements: `query` / `exists` / `show` /
 * named-predicate-definition / `assert` / `retract` / field-assign / `undef`.
 * (`undef` could be allowed as a way to remove things in a layered file load,
 * but for now files are authoritative — they declare, they don't subtract.)
 *
 * Implementation note: file loading reuses the same `applyMutation` path the
 * MCP mutation tools take, with a synthetic transaction. The transaction's
 * snapshot is harmless (a deep-clone of an initially-empty `WorldState`); the
 * `applied` log accumulates but is discarded. Future cleanup may extract a
 * shared `applyToDefinition` that bypasses transaction bookkeeping.
 */

import { readFileSync } from "node:fs";
import { GameDefinition, instantiate, type Module } from "../core/index.js";
import { Transaction, applyMutation } from "../mutation/index.js";
import { parseStatements } from "../query/index.js";

export class DslLoadError extends Error {
  constructor(message: string, public readonly path: string) {
    super(`${path}: ${message}`);
    this.name = "DslLoadError";
  }
}

export interface LoadOptions {
  module: Module;
  /** Optional file path used in error messages. */
  source?: string;
}

export function loadDslText(
  def: GameDefinition,
  text: string,
  options: LoadOptions,
): void {
  if (options.module === "prelude") {
    // Prelude files load via this path too; there's no "writable module"
    // restriction for file loads (the restriction only applies to MCP `begin`
    // tool calls). Use a synthetic transaction tagged at the file's module.
  }
  const path = options.source ?? "<input>";
  let statements;
  try {
    statements = parseStatements(text);
  } catch (e) {
    throw new DslLoadError((e as Error).message, path);
  }

  // Synthetic transaction: clones an empty state. Cheap.
  const state = instantiate(def);
  const tx = Transaction.begin({
    id: "<file-load>",
    module: options.module === "prelude" ? "game" : options.module,
    def,
    state,
  });

  for (const stmt of statements) {
    if (stmt.kind !== "mutation") {
      throw new DslLoadError(
        `file-scope statements must be \`def …\`; got ${stmt.kind}`,
        path,
      );
    }
    const m = stmt.mutation;
    if (m.type !== "defTrait" && m.type !== "defRelation" && m.type !== "defAction"
        && m.type !== "defKind" && m.type !== "defRule" && m.type !== "defRulebook"
        && m.type !== "defEntity") {
      throw new DslLoadError(
        `file-scope statements must be \`def …\`; got ${m.type}`,
        path,
      );
    }
    try {
      // Apply directly to def with the file's module attribution. We override
      // the transaction's module (which the prelude case mapped above) by
      // constructing a temp transaction at the right module.
      const moduleTx =
        options.module === tx.module
          ? tx
          : Transaction.begin({
              id: "<file-load-module-override>",
              module: options.module as "game" | "session",
              def,
              state,
            });
      applyMutation(m, moduleTx, def, state);
      // Also update spec entities' module to reflect the file's module
      // (Transaction.begin maps prelude → game internally; we rewrite here).
      if (options.module === "prelude") {
        rewriteJustAddedToPrelude(def, m);
      }
    } catch (e) {
      throw new DslLoadError((e as Error).message, path);
    }
  }
}

export function loadDslFile(
  def: GameDefinition,
  filePath: string,
  module: Module,
): void {
  const text = readFileSync(filePath, "utf-8");
  loadDslText(def, text, { module, source: filePath });
}

/**
 * The transactional `applyMutation` path stamps the transaction's WritableModule
 * (game or session). Prelude file loads need their additions tagged "prelude"
 * — this helper rewrites the most-recently-added objects' `module` field.
 *
 * Definitions are deeply readonly; we replace each entry on the relevant
 * GameDefinition Map with a structuredClone whose module is "prelude".
 */
function rewriteJustAddedToPrelude(
  def: GameDefinition,
  m: import("../query/ast.js").MutationStatement,
): void {
  const target: "prelude" = "prelude";
  switch (m.type) {
    case "defTrait": {
      const t = def.trait(m.spec.id);
      replaceTrait(def, { ...t, module: target });
      // Trait-owned relations/actions/rules also need rewriting.
      for (const r of t.relations) replaceRelation(def, { ...r, module: target });
      for (const a of t.actions) replaceAction(def, { ...a, module: target });
      for (const rl of t.rules) replaceRule(def, { ...rl, module: target });
      return;
    }
    case "defRelation": {
      const r = def.relation(m.spec.id);
      replaceRelation(def, { ...r, module: target });
      return;
    }
    case "defAction": {
      const a = def.action(m.spec.id);
      replaceAction(def, { ...a, module: target });
      return;
    }
    case "defKind": {
      const k = def.kind(m.spec.id);
      replaceKind(def, { ...k, module: target });
      return;
    }
    case "defRulebook": {
      const rb = def.rulebook(m.spec.id);
      replaceRulebook(def, { ...rb, module: target });
      return;
    }
    case "defRule": {
      const rl = def.rule(m.spec.id);
      replaceRule(def, { ...rl, module: target });
      return;
    }
    case "defEntity": {
      const e = def.initialEntity(m.spec.id);
      replaceInitialEntity(def, { ...e, module: target });
      return;
    }
    default:
      return;
  }
}

// Replace helpers — bypass GameDefinition's add-time duplicate check by
// poking the private Maps. The Maps are accessed via `(def as any)` since
// GameDefinition encapsulates them; this is a controlled exception used only
// during file load to retag prelude additions.

type DefInternals = {
  _traits: Map<string, unknown>;
  _relations: Map<string, unknown>;
  _actions: Map<string, unknown>;
  _kinds: Map<string, unknown>;
  _rulebooks: Map<string, unknown>;
  _rules: Array<{ id: string }>;
  _initialEntities: Array<{ id: string }>;
};

function asInternals(def: GameDefinition): DefInternals {
  return def as unknown as DefInternals;
}

type IdHaver = { id: string; [k: string]: unknown };

function replaceTrait(def: GameDefinition, t: IdHaver): void {
  asInternals(def)._traits.set(t.id, t);
}
function replaceRelation(def: GameDefinition, r: IdHaver): void {
  asInternals(def)._relations.set(r.id, r);
}
function replaceAction(def: GameDefinition, a: IdHaver): void {
  asInternals(def)._actions.set(a.id, a);
}
function replaceKind(def: GameDefinition, k: IdHaver): void {
  asInternals(def)._kinds.set(k.id, k);
}
function replaceRulebook(def: GameDefinition, rb: IdHaver): void {
  asInternals(def)._rulebooks.set(rb.id, rb);
}
function replaceRule(def: GameDefinition, r: IdHaver): void {
  const rules = asInternals(def)._rules;
  const idx = rules.findIndex((x) => x.id === r.id);
  if (idx >= 0) rules[idx] = r as { id: string };
}
function replaceInitialEntity(def: GameDefinition, e: IdHaver): void {
  const entities = asInternals(def)._initialEntities;
  const idx = entities.findIndex((x) => x.id === e.id);
  if (idx >= 0) entities[idx] = e as { id: string };
}

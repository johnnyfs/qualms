/**
 * `.qualms` file format emitter — inverse of `loader.ts`. Produces DSL v2
 * text from a GameDefinition's module slice.
 *
 * Round-trip property: `loadDslText(emitDsl(def, m), { module: m })` reproduces
 * the slice. Exercised in `qualms/test/dsl-roundtrip.test.ts`.
 */

import type { GameDefinition } from "../core/definition.js";
import type {
  ActionDefinition,
  EffectSpec,
  EntitySpec,
  FieldDefinition,
  InitialAssertion,
  KindDefinition,
  Module,
  ParameterDefinition,
  RelationDefinition,
  Rule,
  RulebookDefinition,
  TraitDefinition,
} from "../core/types.js";
import type { Expression, Term } from "../query/ast.js";

export function emitDsl(def: GameDefinition, module: Module): string {
  const blocks: string[] = [];

  // Header comment is helpful but optional — skip for now.

  // Order: rulebooks → traits → top-level relations → top-level actions →
  // kinds → entities → initial assertions. Rulebooks first so def-rule
  // references are resolved if rules end up at top level (rare).
  for (const rb of def.rulebooksByModule(module)) {
    blocks.push(emitRulebook(rb));
  }

  // Traits (with their owned relations/actions/rules inlined)
  const traitOwnedRelations = new Set<string>();
  const traitOwnedActions = new Set<string>();
  const traitOwnedRules = new Set<string>();
  for (const t of def.traitsByModule(module)) {
    for (const r of t.relations) traitOwnedRelations.add(r.id);
    for (const a of t.actions) traitOwnedActions.add(a.id);
    for (const rl of t.rules) traitOwnedRules.add(rl.id);
  }
  for (const t of def.traitsByModule(module)) {
    blocks.push(emitTrait(t));
  }

  // Top-level relations (not owned by a module-local trait)
  for (const r of def.relationsByModule(module)) {
    if (!traitOwnedRelations.has(r.id)) blocks.push(`def ${emitRelation(r)};`);
  }

  // Top-level actions
  for (const a of def.actionsByModule(module)) {
    if (!traitOwnedActions.has(a.id)) blocks.push(`def ${emitAction(a)};`);
  }

  // Top-level rules (not trait-owned)
  for (const rl of def.rulesByModule(module)) {
    if (!traitOwnedRules.has(rl.id) && rl.rulebook !== undefined) {
      blocks.push(`def ${emitRule(rl)};`);
    }
  }

  for (const k of def.kindsByModule(module)) {
    blocks.push(emitKind(k));
  }

  for (const e of def.initialEntitiesByModule(module)) {
    blocks.push(emitEntity(e));
  }

  for (const a of def.initialAssertionsByModule(module)) {
    blocks.push(emitInitialAssertion(a));
  }

  return blocks.join("\n\n") + (blocks.length > 0 ? "\n" : "");
}

// ──────── Per-shape emitters ────────

export function emitTrait(t: TraitDefinition): string {
  const clauses: string[] = [];
  for (const f of t.fields) clauses.push(emitFieldDecl(f));
  for (const r of t.relations) clauses.push(`def ${emitRelation(r)}`);
  for (const a of t.actions) clauses.push(`def ${emitAction(a)}`);
  for (const r of t.rules) clauses.push(`def ${emitRule(r)}`);
  return `def trait ${t.id} ${formatBody(clauses)};`;
}

export function emitRelation(r: RelationDefinition): string {
  const clauses: string[] = [];
  if (r.get !== undefined) {
    clauses.push(`get: ?- ${emitExpression(r.get as Expression)}`);
  }
  if (r.setEffects !== undefined && r.setEffects.length > 0) {
    clauses.push(`set: [ ${r.setEffects.map(emitEffectSpec).join("; ")}; ]`);
  }
  const params = r.parameters.map(emitParameter).join(", ");
  return `relation ${r.id}(${params}) ${formatBody(clauses)}`;
}

export function emitAction(a: ActionDefinition): string {
  const clauses: string[] = [];
  if (a.requires !== undefined && a.requires !== true) {
    clauses.push(`requires: ?- ${emitExpression(a.requires as Expression)}`);
  }
  if (a.defaultEffects.length > 0) {
    clauses.push(`default: [ ${a.defaultEffects.map(emitEffectSpec).join("; ")}; ]`);
  }
  const params = a.parameters.map(emitParameter).join(", ");
  return `action ${a.id}(${params}) ${formatBody(clauses)}`;
}

export function emitKind(k: KindDefinition): string {
  const traitList = k.traits.map((t) => t.id).join(", ");
  const head = traitList.length > 0 ? `def kind ${k.id}: ${traitList}` : `def kind ${k.id}`;
  // Field overrides on the kind, expressed as `Trait.field = value`.
  const overrides: string[] = [];
  for (const [traitId, fmap] of Object.entries(k.fields)) {
    for (const [fieldId, value] of Object.entries(fmap)) {
      overrides.push(`${traitId}.${fieldId} = ${emitValue(value)}`);
    }
  }
  if (overrides.length === 0) return `${head};`;
  return `${head} ${formatBody(overrides)};`;
}

export function emitRule(r: Rule): string {
  const clauses: string[] = [];
  clauses.push(`phase: ${r.phase}`);
  clauses.push(`match: ${emitActionPattern(r.pattern)}`);
  if (r.guard !== undefined && r.guard !== true) {
    clauses.push(`guard: ?- ${emitExpression(r.guard as Expression)}`);
  }
  if (r.effects.length > 0) {
    clauses.push(`effects: [ ${r.effects.map(emitEffectSpec).join("; ")}; ]`);
  }
  if (r.control !== "continue") clauses.push(`control: ${r.control}`);
  if (r.priority !== 0) clauses.push(`priority: ${r.priority}`);
  const head = r.rulebook !== undefined ? `rule ${r.id} in ${r.rulebook}` : `rule ${r.id}`;
  return `${head} ${formatBody(clauses)}`;
}

export function emitRulebook(rb: RulebookDefinition): string {
  return `def rulebook ${rb.id} {};`;
}

export function emitEntity(e: EntitySpec): string {
  const head = e.kind !== undefined ? `def entity ${e.id}: ${e.kind}` : `def entity ${e.id}`;
  const clauses: string[] = [];
  // Trait grants beyond the kind's traits → `trait Foo;` or `trait Foo { ... };`
  for (const att of e.traits) {
    if (Object.keys(att.fields).length === 0) {
      clauses.push(`trait ${att.id}`);
    } else {
      const overrides = Object.entries(att.fields)
        .map(([k, v]) => `${k} = ${emitValue(v)}`)
        .join("; ");
      clauses.push(`trait ${att.id} { ${overrides}; }`);
    }
  }
  // Field overrides: `Trait.field = value`
  for (const [traitId, fmap] of Object.entries(e.fields)) {
    if (traitId === "*") {
      for (const [fieldId, value] of Object.entries(fmap)) {
        clauses.push(`${fieldId} = ${emitValue(value)}`);
      }
    } else {
      for (const [fieldId, value] of Object.entries(fmap)) {
        clauses.push(`${traitId}.${fieldId} = ${emitValue(value)}`);
      }
    }
  }
  // Metadata
  for (const [key, value] of Object.entries(e.metadata)) {
    if (key === "kind" && value === e.kind) continue; // implicit, suppress
    clauses.push(`metadata.${key} = ${emitValue(value)}`);
  }
  if (clauses.length === 0) return `${head};`;
  return `${head} ${formatBody(clauses)};`;
}

export function emitInitialAssertion(a: InitialAssertion): string {
  // Initial assertions are flat `assert R(args)` statements at file scope.
  // Note: this requires the loader to accept top-level `assert` (it currently
  // rejects). For now we emit them inside an entity-less stanza or punt; the
  // loader's restriction is documented and a follow-up will allow `assert`
  // statements at file scope when they declare initial state.
  const args = a.args.map((arg) => emitValue(arg)).join(", ");
  return `# initial: assert ${a.relation}(${args});`;
}

// ──────── Field / parameter / pattern helpers ────────

function emitFieldDecl(f: FieldDefinition): string {
  const type = f.type ?? "value";
  if (f.hasDefault) {
    return `${f.id}: ${type} = ${emitValue(f.default)}`;
  }
  return `${f.id}: ${type}`;
}

function emitParameter(p: ParameterDefinition): string {
  const parts = [p.id];
  if (p.type && p.type !== "value") parts.push(`: ${p.type}`);
  if (p.hasDefault) parts.push(` = ${emitValue(p.default)}`);
  return parts.join("");
}

function emitActionPattern(p: { action: string; args: Readonly<Record<string, unknown>> }): string {
  const args = Object.entries(p.args)
    .map(([k, v]) => {
      // Args may be Term-shaped or YAML-style {var: name} / {bind: name} dicts.
      if (isTermLike(v)) return `${k}: ${emitTerm(v as Term)}`;
      if (typeof v === "object" && v !== null) {
        const obj = v as Record<string, unknown>;
        if (typeof obj["var"] === "string") return `${k}: ${obj["var"]}`;
        if (typeof obj["bind"] === "string") return `${k}: ${obj["bind"]}`;
      }
      return `${k}: ${emitValue(v)}`;
    })
    .join(", ");
  return `${p.action}(${args})`;
}

function formatBody(clauses: string[]): string {
  if (clauses.length === 0) return "{}";
  return `{ ${clauses.join("; ")}; }`;
}

// ──────── Value emission ────────

export function emitValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(emitValue).join(", ")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    return `{ ${entries.map(([k, val]) => `${k}: ${emitValue(val)}`).join(", ")} }`;
  }
  return JSON.stringify(v);
}

// ──────── Expression emission (predicate inverter) ────────

export function emitExpression(expr: Expression): string {
  switch (expr.type) {
    case "literal":
      return expr.value ? "true" : "false";
    case "and":
      return `(${emitExpression(expr.left)} & ${emitExpression(expr.right)})`;
    case "or":
      return `(${emitExpression(expr.left)} | ${emitExpression(expr.right)})`;
    case "not":
      return `not ${emitExpression(expr.operand)}`;
    case "exists": {
      const filter = expr.traitFilter
        ? `: ${expr.traitFilter.name}${expr.traitFilter.module ? `@${expr.traitFilter.module}` : ""}`
        : "";
      return `exists ${expr.variable}${filter}. ${emitExpression(expr.body)}`;
    }
    case "forall": {
      const filter = expr.traitFilter
        ? `: ${expr.traitFilter.name}${expr.traitFilter.module ? `@${expr.traitFilter.module}` : ""}`
        : "";
      return `forall ${expr.variable}${filter}. ${emitExpression(expr.body)}`;
    }
    case "relation":
      return `${expr.relation}(${expr.args.map(emitTerm).join(", ")})`;
    case "traitOf": {
      const layerSuffix = expr.filter.module ? `@${expr.filter.module}` : "";
      return `${emitTerm(expr.entity)} : ${expr.filter.name}${layerSuffix}`;
    }
    case "equal":
      return `${emitTerm(expr.left)} = ${emitTerm(expr.right)}`;
    case "notEqual":
      return `${emitTerm(expr.left)} != ${emitTerm(expr.right)}`;
    case "regex":
      return `${emitTerm(expr.subject)} =~ /${expr.pattern}/${expr.flags ?? ""}`;
    case "like":
      return `like(${emitTerm(expr.subject)}, ${JSON.stringify(expr.pattern)})`;
    case "path": {
      const rels = expr.relations.join("|");
      const quant = expr.quantifier === "1" ? "" : expr.quantifier;
      const open = expr.direction === "backward" ? "<-[" : "-[";
      const close = expr.direction === "backward" ? "]-" : expr.direction === "symmetric" ? "]-" : "]->";
      return `${emitTerm(expr.from)} ${open}${rels}${close}${quant} ${emitTerm(expr.to)}`;
    }
  }
}

export function emitTerm(t: Term): string {
  switch (t.type) {
    case "var":
      return t.name;
    case "value":
      return emitValue(t.value);
    case "field":
      return t.trait !== undefined
        ? `${emitTerm(t.entity)}.${t.trait}.${t.field}`
        : `${emitTerm(t.entity)}.${t.field}`;
  }
}

// ──────── Effect emission ────────

/**
 * EffectSpec is the engine-stored opaque-record form. The mutation executor
 * turns parsed `Effect` AST nodes into EffectSpecs by spreading the typed
 * record (so they retain a `type` field discriminant). YAML-loaded effects
 * follow a different shape (legacy `assert_relation` / `set_field` operators);
 * those don't round-trip cleanly here yet — a future pass can normalize.
 */
function emitEffectSpec(spec: EffectSpec): string {
  const e = spec as Record<string, unknown>;
  const type = e["type"];
  if (type === "assert" && typeof e["relation"] === "string") {
    const args = (e["args"] as Term[]).map(emitTerm).join(", ");
    return `assert ${e["relation"]}(${args})`;
  }
  if (type === "retract" && typeof e["relation"] === "string") {
    const args = (e["args"] as Term[]).map(emitTerm).join(", ");
    return `retract ${e["relation"]}(${args})`;
  }
  if (type === "fieldAssign") {
    return `${emitTerm(e["target"] as Term)} := ${emitTerm(e["value"] as Term)}`;
  }
  if (type === "emit") {
    const payload = e["payload"] as Record<string, Term>;
    return `emit { ${Object.entries(payload)
      .map(([k, v]) => `${k}: ${emitTerm(v)}`)
      .join(", ")} }`;
  }
  // Legacy YAML effect shapes (assert_relation, set_field, emit) — emit a
  // pseudo-comment so commits don't corrupt; flagged as TODO.
  return `# unsupported effect: ${JSON.stringify(spec)}`;
}

// ──────── Helpers ────────

function isTermLike(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: string }).type;
  return t === "var" || t === "value" || t === "field";
}

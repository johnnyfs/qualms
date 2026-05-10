/**
 * Best-effort serialization of a `MutationStatement` back to its DSL surface
 * form. Used by `__diff` to render the applied-mutation log for agents.
 *
 * Not a perfect inverse of the parser — body literals are emitted as compact
 * JSON-ish forms. Sufficient for human-readable diffs.
 */

import type { Effect, MutationStatement, Term } from "../query/ast.js";

export function unparseMutation(m: MutationStatement): string {
  switch (m.type) {
    case "assert":
      return `assert ${m.relation}(${m.args.map(unparseTerm).join(", ")})`;
    case "retract":
      return `retract ${m.relation}(${m.args.map(unparseTerm).join(", ")})`;
    case "fieldAssign":
      return `${unparseTerm(m.target)} := ${unparseTerm(m.value)}`;
    case "setAdd":
      return `${unparseTerm(m.target)} += ${unparseTerm(m.element)}`;
    case "setRemove":
      return `${unparseTerm(m.target)} -= ${unparseTerm(m.element)}`;
    case "defTrait":
      return `def trait ${m.spec.id} ${unparseSpec(m.spec)}`;
    case "defRelation":
      return `def relation ${m.spec.id}(${m.spec.parameters
        .map((p) => p.id)
        .join(", ")}) ${unparseSpec(m.spec, ["id", "parameters"])}`;
    case "defAction":
      return `def action ${m.spec.id}(${m.spec.parameters
        .map((p) => p.id)
        .join(", ")}) ${unparseSpec(m.spec, ["id", "parameters"])}`;
    case "defKind":
      return `def kind ${m.spec.id} ${unparseSpec(m.spec)}`;
    case "defRule":
      return `def rule ${m.spec.id} in ${m.spec.rulebook} ${unparseSpec(m.spec, ["id", "rulebook"])}`;
    case "defRulebook":
      return `def rulebook ${m.spec.id} {}`;
    case "defEntity":
      return m.spec.kind !== undefined
        ? `def entity ${m.spec.id} : ${m.spec.kind} ${unparseSpec(m.spec, ["id", "kind"])}`
        : `def entity ${m.spec.id} ${unparseSpec(m.spec)}`;
    case "undef":
      return `undef ${m.targetKind} ${m.name}`;
  }
}

function unparseTerm(t: Term): string {
  switch (t.type) {
    case "var":
      return t.name;
    case "value":
      if (typeof t.value === "string") return JSON.stringify(t.value);
      return String(t.value);
    case "field":
      return t.trait !== undefined
        ? `${unparseTerm(t.entity)}.${t.trait}.${t.field}`
        : `${unparseTerm(t.entity)}.${t.field}`;
  }
}

function unparseEffect(e: Effect): string {
  switch (e.type) {
    case "assert":
      return `assert ${e.relation}(${e.args.map(unparseTerm).join(", ")})`;
    case "retract":
      return `retract ${e.relation}(${e.args.map(unparseTerm).join(", ")})`;
    case "fieldAssign":
      return `${unparseTerm(e.target)} := ${unparseTerm(e.value)}`;
    case "setAdd":
      return `${unparseTerm(e.target)} += ${unparseTerm(e.element)}`;
    case "setRemove":
      return `${unparseTerm(e.target)} -= ${unparseTerm(e.element)}`;
    case "emit":
      return `emit { ${Object.entries(e.payload)
        .map(([k, v]) => `${k}: ${unparseTerm(v)}`)
        .join(", ")} }`;
  }
}

function unparseSpec(spec: object, omit: string[] = ["id"]): string {
  const entries = Object.entries(spec as Record<string, unknown>).filter(
    ([k, v]) => !omit.includes(k) && v !== undefined,
  );
  if (entries.length === 0) return "{}";
  const body = entries.map(([k, v]) => `${k}: ${unparseValue(v)}`).join(", ");
  return `{ ${body} }`;
}

function unparseValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    // Special-case Effect arrays (have a `type` discriminant).
    if (v.length > 0 && isEffect(v[0])) {
      return `[ ${v.map((e) => unparseEffect(e as Effect)).join(", ")} ]`;
    }
    return `[ ${v.map(unparseValue).join(", ")} ]`;
  }
  if (typeof v === "object") {
    // Could be an Expression node — render compactly.
    if (isExpressionLike(v)) return `?- ${unparseExpression(v as Record<string, unknown>)}`;
    if (isTermLike(v)) return unparseTerm(v as Term);
    const obj = v as Record<string, unknown>;
    return `{ ${Object.entries(obj)
      .map(([k, val]) => `${k}: ${unparseValue(val)}`)
      .join(", ")} }`;
  }
  return JSON.stringify(v);
}

function isEffect(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: string }).type;
  return (
    t === "assert" ||
    t === "retract" ||
    t === "fieldAssign" ||
    t === "setAdd" ||
    t === "setRemove" ||
    t === "emit"
  );
}

function isTermLike(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: string }).type;
  return t === "var" || t === "value" || t === "field";
}

function isExpressionLike(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: string }).type;
  return (
    t === "and" ||
    t === "or" ||
    t === "not" ||
    t === "exists" ||
    t === "forall" ||
    t === "relation" ||
    t === "literal" ||
    t === "equal" ||
    t === "notEqual" ||
    t === "regex" ||
    t === "like" ||
    t === "path" ||
    t === "traitOf"
  );
}

function unparseExpression(e: Record<string, unknown>): string {
  // Compact rendering — not a full unparser. Round-trip via `?- <body>` only when
  // the parser supports the form.
  return JSON.stringify(e);
}

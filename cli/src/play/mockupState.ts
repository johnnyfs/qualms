import { language } from "@quealm/qualms";

const {
  languageRuntimeInternals,
  playLanguageCall,
  playLanguageQuery,
} = language;

type Env = Record<string, language.GroundTerm>;

export interface MockupMenuState {
  readonly call?: language.RelationAtom;
}

export const initialMockupMenuState: MockupMenuState = {};

export type MockupMenuOption = {
  readonly label: string;
  readonly targets: readonly language.RelationAtom[];
  readonly env: Env;
};

export interface MockupMenuFrame {
  readonly headers: readonly string[];
  readonly options: readonly MockupMenuOption[];
}

export type MockupMenuTransition =
  | { readonly kind: "state"; readonly state: MockupMenuState }
  | {
      readonly kind: "action";
      readonly atom: language.RelationAtom;
      readonly result: language.LanguagePlayResult;
      readonly nextState: MockupMenuState;
    }
  | { readonly kind: "error"; readonly message: string };

export function buildMockupFrame(
  model: language.StoryModel,
  state: MockupMenuState,
): MockupMenuFrame {
  const call = state.call ?? model.startingMockup;
  if (!call) {
    return {
      headers: ["No starting mockup defined."],
      options: [],
    };
  }
  const resolved = resolveMockup(model, call);
  if (!resolved) {
    return {
      headers: [`Missing mockup: ${call.relation}`],
      options: [],
    };
  }
  const { mockup, env } = resolved;
  const title = mockup.title.map((term) => renderTerm(model, term, env)).join(" ");
  const headers = [title || mockup.id, ...renderDetails(model, mockup.detail, env)];
  return {
    headers,
    options: renderOptions(model, mockup.options, env),
  };
}

export function selectMockupOption(
  model: language.StoryModel,
  option: MockupMenuOption,
): MockupMenuTransition {
  let atom: language.RelationAtom;
  try {
    atom = languageRuntimeInternals.groundAtom(model, option.targets[0]!, option.env);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { kind: "error", message };
  }

  if (model.mockups.has(atom.relation)) {
    return { kind: "state", state: { call: atom } };
  }
  if (model.actions.has(atom.relation)) {
    const result = playLanguageCall(model, atom);
    const next = result.status === "passed"
      ? nextMockupState(model, option.targets.slice(1), option.env)
      : undefined;
    return {
      kind: "action",
      atom,
      result,
      nextState: next ?? initialMockupMenuState,
    };
  }
  return { kind: "error", message: `unknown mockup or action '${atom.relation}'` };
}

export function formatMockupResult(
  result: language.LanguagePlayResult | undefined,
  error: string | undefined,
): readonly string[] {
  if (error) return [error];
  if (!result) return [];
  if (result.status === "passed") {
    return [
      ...result.effects.map(formatEffect),
      ...result.events.map(formatEvent),
    ];
  }
  return result.reasons.length > 0 ? result.reasons : ["fail"];
}

function formatEffect(effect: language.Effect): string {
  const prefix = effect.polarity === "retract" ? "!" : "";
  return `${prefix}${formatFact(effect.fact)}`;
}

function formatFact(fact: language.Fact): string {
  return `${fact.relation}(${fact.args.map((arg) => renderGroundTerm(undefined, arg)).join(", ")})`;
}

function formatEvent(event: language.LanguageEvent): string {
  return `${event.event}(${event.args.map((arg) => renderGroundTerm(undefined, arg)).join(", ")})`;
}

function resolveMockup(
  model: language.StoryModel,
  call: language.RelationAtom,
): { readonly mockup: language.MockupStatement; readonly env: Env } | undefined {
  const mockup = model.mockups.get(call.relation);
  if (!mockup) return undefined;
  const args = call.args.map((arg) => model.groundTermFromTerm(arg));
  const envs = languageRuntimeInternals.bindParameters(model, mockup.parameters, args);
  const env = envs[0];
  return env ? { mockup, env } : undefined;
}

function renderDetails(
  model: language.StoryModel,
  detail: readonly language.MockupDetail[],
  env: Env,
): readonly string[] {
  const lines: string[] = [];
  for (const item of detail) {
    if (item.kind === "line") {
      const line = item.terms.map((term) => renderDetailTerm(model, term, env)).join("");
      if (line.trim().length > 0) lines.push(line);
      continue;
    }
    const matches = evalMockupBinding(model, item.name, item.expression, env);
    const values: string[] = [];
    for (const match of matches) {
      const value = match[item.name];
      if (value) values.push(renderGroundTerm(model, value));
    }
    const rendered = [...dedupe(values)].sort((a, b) => a.localeCompare(b));
    if (rendered.length > 0) lines.push(`${item.name}: ${rendered.join(", ")}`);
  }
  return [...dedupe(lines)].sort((a, b) => a.localeCompare(b));
}

function renderOptions(
  model: language.StoryModel,
  options: readonly language.MockupOption[],
  env: Env,
): readonly MockupMenuOption[] {
  const rendered: MockupMenuOption[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    if (option.kind === "when") {
      if (evalMockupCondition(model, option.condition, env)) {
        for (const nested of renderOptions(model, option.options, env)) {
          pushOption(rendered, seen, nested);
        }
      }
      continue;
    }
    if (option.kind === "static") {
      pushOption(rendered, seen, { label: option.label, targets: option.targets, env });
      continue;
    }
    const matches = evalMockupBinding(model, option.name, option.expression, env);
    for (const match of matches) {
      const value = match[option.name];
      if (!value) continue;
      pushOption(rendered, seen, {
        label: renderGroundTerm(model, value),
        targets: option.targets,
        env: match,
      });
    }
  }
  return rendered;
}

function evalMockupCondition(
  model: language.StoryModel,
  condition: language.Expression,
  env: Env,
): boolean {
  return languageRuntimeInternals.evalExpression(model, condition, env).length > 0;
}

function evalMockupBinding(
  model: language.StoryModel,
  name: string,
  expression: language.Expression,
  env: Env,
): readonly Env[] {
  if (expression.kind === "relation" && model.queries.has(expression.atom.relation)) {
    let atom: language.RelationAtom;
    try {
      atom = languageRuntimeInternals.groundAtom(model, expression.atom, env);
    } catch {
      return [];
    }
    const result = playLanguageQuery(model, atom);
    if (result.status !== "passed") return [];
    const mapped: Env[] = [];
    for (const binding of result.bindings) {
      const direct = binding[name];
      const fallback = direct ?? chooseQueryValue(binding, result.outputs);
      if (!fallback) continue;
      mapped.push({ ...env, ...binding, [name]: fallback });
    }
    return mapped;
  }
  return languageRuntimeInternals.evalExpression(model, expression, env);
}

function renderDetailTerm(
  model: language.StoryModel,
  term: language.Term,
  env: Env,
): string {
  if (term.kind === "relationInstance" && model.queries.has(term.atom.relation)) {
    const values = evalQueryTerm(model, term.atom, env).map((value) => renderGroundTerm(model, value));
    return [...dedupe(values)].sort((a, b) => a.localeCompare(b)).join(", ");
  }
  return renderTerm(model, term, env);
}

function evalQueryTerm(
  model: language.StoryModel,
  atom: language.RelationAtom,
  env: Env,
): readonly language.GroundTerm[] {
  let grounded: language.RelationAtom;
  try {
    grounded = languageRuntimeInternals.groundAtom(model, atom, env);
  } catch {
    return [];
  }
  const result = playLanguageQuery(model, grounded);
  if (result.status !== "passed") return [];
  const values: language.GroundTerm[] = [];
  for (const binding of result.bindings) {
    const value = chooseQueryValue(binding, result.outputs);
    if (value) values.push(value);
  }
  return values;
}

function chooseQueryValue(
  binding: Record<string, language.GroundTerm>,
  outputs: readonly string[],
): language.GroundTerm | undefined {
  return (
    binding.target ??
    binding.topic ??
    binding.item ??
    binding.current ??
    (outputs.length === 1 ? binding[outputs[0]!] : undefined)
  );
}

function pushOption(
  options: MockupMenuOption[],
  seen: Set<string>,
  option: MockupMenuOption,
): void {
  const key = `${option.label}|${JSON.stringify(option.targets)}|${JSON.stringify(option.env)}`;
  if (seen.has(key)) return;
  seen.add(key);
  options.push(option);
}

function nextMockupState(
  model: language.StoryModel,
  targets: readonly language.RelationAtom[],
  env: Env,
): MockupMenuState | undefined {
  for (const target of targets) {
    const atom = languageRuntimeInternals.groundAtom(model, target, env);
    if (model.mockups.has(atom.relation)) return { call: atom };
  }
  return undefined;
}

function renderTerm(model: language.StoryModel, term: language.Term, env: Env): string {
  const resolved = languageRuntimeInternals.resolveTerm(model, term, env);
  return resolved ? renderGroundTerm(model, resolved) : emitTerm(term);
}

function renderGroundTerm(model: language.StoryModel | undefined, term: language.GroundTerm): string {
  if (term.kind === "string") return term.value;
  if (term.kind === "id" && model) return model.displayEntityId(term.id);
  return languageRuntimeInternals.emitGroundTerm(term, model);
}

function emitTerm(term: language.Term): string {
  switch (term.kind) {
    case "identifier":
      return term.id;
    case "variable":
      return `?${term.id}`;
    case "wildcard":
      return "_";
    case "string":
      return term.value;
    case "number":
      return String(term.value);
    case "relationInstance":
      return `${term.atom.relation}(...)`;
  }
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

import type { language } from "@quealm/qualms";
import type { PlayConfig, QueryConfig } from "./config.js";
import { defaultDisplayName, type NameIndex } from "./naming.js";
import type { VerbTable } from "./verbs.js";

type RelationAtom = language.RelationAtom;
type LanguagePlayResult = language.LanguagePlayResult;
type LanguageQueryResult = language.LanguageQueryResult;
type GroundTerm = language.GroundTerm;

const DEFAULT_VERB_TEMPLATES = new Map<string, string>([
  ["Take", "You take the $target."],
  ["Drop", "You drop the $target."],
  ["Go", "You go to the $target."],
  ["Open", "You open the $target."],
  ["Close", "You close the $target."],
  ["Unlock", "You unlock the $target with the $arg2."],
  ["Lock", "You lock the $target with the $arg2."],
  ["Examine", "You examine the $target."],
  ["TalkAbout", "You talk to the $target about $arg2."],
  ["StopTalking", "You stop talking to the $target."],
]);

const ACTION_DENIAL_TEMPLATES = new Map<string, string>([
  ["Take", "You can't take the $target."],
  ["Drop", "You can't drop the $target."],
  ["Go", "You can't go to the $target."],
  ["Open", "You can't open the $target."],
  ["Close", "You can't close the $target."],
  ["Unlock", "You can't unlock the $target with the $arg2."],
  ["Lock", "You can't lock the $target with the $arg2."],
  ["Examine", "You can't see the $target from here."],
  ["TalkAbout", "You can't talk to the $target about $arg2."],
  ["StopTalking", "You can't stop talking to the $target."],
]);

const DEFAULT_QUERY_TEMPLATES = new Map<
  string,
  { template: string; empty: string; item: string; join?: string }
>([
  [
    "Inventory",
    {
      template: "You're carrying $items.",
      empty: "You're empty-handed.",
      item: "the $item",
      join: ", ",
    },
  ],
]);

const DEFAULT_REASON_MESSAGES = new Map<string, ReasonMessage>([
  ["Carrying", { negative: "You aren't carrying the $arg1." }],
  ["At", { negative: "$arg0 isn't at $arg1." }],
  ["Path", { negative: "There's no path from $arg0 to $arg1." }],
  [
    "Locked",
    { positive: "The $arg0 is locked.", negative: "The $arg0 isn't locked." },
  ],
  [
    "Opened",
    {
      positive: "The $arg0 is already open.",
      negative: "The $arg0 is closed.",
    },
  ],
  ["LockedWith", { negative: "The $arg1 doesn't fit the $arg0." }],
  ["IsColocated", { negative: "The $arg1 isn't near you." }],
  ["IsVisibleTo", { negative: "You can't see the $arg1 from here." }],
  ["TalksAbout", { negative: "The $arg0 has nothing to say about $arg1." }],
  ["WillTalkAbout", { negative: "The $arg1 won't talk about that." }],
  ["Transparent", {}],
  ["ConveysVisibility", {}],
]);

interface ReasonMessage {
  readonly positive?: string;
  readonly negative?: string;
}

export interface FormatContext {
  readonly config: PlayConfig;
  readonly names: NameIndex;
  readonly verbs: VerbTable;
  readonly model: language.StoryModel;
  readonly result?: LanguagePlayResult;
  readonly queryResult?: LanguageQueryResult;
}

export function formatResult(atom: RelationAtom, ctx: FormatContext): string {
  if (ctx.queryResult) return formatQuery(atom, ctx.queryResult, ctx);
  if (ctx.result) {
    return ctx.result.status === "passed"
      ? formatSuccess(atom, ctx.result, ctx)
      : formatFailure(atom, ctx.result, ctx);
  }
  return "";
}

function formatSuccess(
  atom: RelationAtom,
  result: LanguagePlayResult,
  ctx: FormatContext,
): string {
  for (const event of result.events) {
    const template = ctx.config.events.get(event.event);
    if (template) {
      return applyTemplate(template, groundTermsAsArgs(event.args), ctx);
    }
  }
  const verbConfig = ctx.config.verbs.get(atom.relation);
  if (verbConfig?.template) {
    return applyTemplate(verbConfig.template, atom.args, ctx);
  }
  const builtin = DEFAULT_VERB_TEMPLATES.get(atom.relation);
  if (builtin) return applyTemplate(builtin, atom.args, ctx);
  return `You ${displayActionVerb(atom.relation)}.`;
}

function formatFailure(
  atom: RelationAtom,
  result: LanguagePlayResult,
  ctx: FormatContext,
): string {
  for (const reason of result.reasons) {
    const humanized = humanizeReason(reason, ctx);
    if (humanized) return humanized;
  }
  return "You can't do that.";
}

function formatQuery(
  atom: RelationAtom,
  result: LanguageQueryResult,
  ctx: FormatContext,
): string {
  if (result.status !== "passed") {
    return formatActionDenial(atom.relation, atom.args, ctx) ?? "You can't do that.";
  }
  const queryConfig = ctx.config.queries.get(atom.relation);
  const builtin = DEFAULT_QUERY_TEMPLATES.get(atom.relation);
  const empty = queryConfig?.empty ?? builtin?.empty ?? "Nothing.";
  if (result.bindings.length === 0) return empty;

  const itemTemplate = queryConfig?.item ?? builtin?.item ?? "the $item";
  const join = queryConfig?.join ?? builtin?.join ?? ", ";
  const items = result.bindings
    .map((binding) => applyTemplateWithBinding(itemTemplate, binding, ctx))
    .join(join);

  const wrap = queryConfig?.template ?? builtin?.template ?? "$items";
  return wrap.replace(/\$items\b/g, items);
}

function humanizeReason(reason: string, ctx: FormatContext): string | undefined {
  const parsed = parseReasonAtom(reason);
  if (!parsed) return undefined;
  // Action-failure path: !ActionId(args). Use action-denial templates rather than fact-reason templates.
  if (parsed.negated && ctx.model.actions.has(parsed.relation)) {
    return formatActionDenial(parsed.relation, parsed.args, ctx);
  }
  const messages = DEFAULT_REASON_MESSAGES.get(parsed.relation);
  if (!messages) return undefined;
  const template = parsed.negated ? messages.negative : messages.positive;
  if (!template) return undefined;
  return applyTemplate(template, parsed.args, ctx);
}

function formatActionDenial(
  actionId: string,
  args: readonly language.Term[],
  ctx: FormatContext,
): string | undefined {
  const verbConfig = ctx.config.verbs.get(actionId);
  if (verbConfig?.denialTemplate) {
    return applyTemplate(verbConfig.denialTemplate, args, ctx);
  }
  const builtin = ACTION_DENIAL_TEMPLATES.get(actionId);
  if (builtin) return applyTemplate(builtin, args, ctx);
  return undefined;
}

interface ParsedReason {
  readonly negated: boolean;
  readonly relation: string;
  readonly args: readonly language.Term[];
}

function parseReasonAtom(reason: string): ParsedReason | undefined {
  const trimmed = reason.trim();
  if (!trimmed) return undefined;
  const negated = trimmed.startsWith("!");
  const body = negated ? trimmed.slice(1).trim() : trimmed;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\(([^()]*)\)$/.exec(body);
  if (!match) return undefined;
  const relation = match[1]!;
  const argsText = match[2]!.trim();
  const args: language.Term[] = [];
  if (argsText) {
    for (const piece of argsText.split(/\s*,\s*/)) {
      if (!piece) continue;
      if (/^"/.test(piece)) {
        args.push({ kind: "string", value: piece.slice(1, -1) });
      } else if (/^-?\d/.test(piece)) {
        args.push({ kind: "number", value: Number(piece) });
      } else if (piece === "_") {
        args.push({ kind: "wildcard" });
      } else if (piece.startsWith("?")) {
        args.push({ kind: "variable", id: piece.slice(1) });
      } else {
        args.push({ kind: "identifier", id: piece });
      }
    }
  }
  return { negated, relation, args };
}

function groundTermsAsArgs(args: readonly GroundTerm[]): readonly language.Term[] {
  return args.map((arg) => {
    switch (arg.kind) {
      case "id":
        return { kind: "identifier", id: arg.id };
      case "string":
        return { kind: "string", value: arg.value };
      case "number":
        return { kind: "number", value: arg.value };
      case "relation":
        return {
          kind: "relationInstance",
          atom: {
            relation: arg.relation,
            args: groundTermsAsArgs(arg.args),
          },
        };
    }
  });
}

function applyTemplate(
  template: string,
  args: readonly language.Term[],
  ctx: FormatContext,
): string {
  return template.replace(/\$([a-zA-Z][a-zA-Z0-9_]*)/g, (whole, name: string) => {
    const idx = resolveTemplateIndex(name, args);
    if (idx === undefined) return whole;
    const arg = args[idx];
    if (!arg) return whole;
    return renderTerm(arg, ctx);
  });
}

function applyTemplateWithBinding(
  template: string,
  binding: Record<string, GroundTerm>,
  ctx: FormatContext,
): string {
  return template.replace(/\$([a-zA-Z][a-zA-Z0-9_]*)/g, (whole, name: string) => {
    const value = binding[name];
    if (value === undefined) return whole;
    return renderTerm(groundTermsAsArgs([value])[0]!, ctx);
  });
}

function resolveTemplateIndex(
  name: string,
  args: readonly language.Term[],
): number | undefined {
  if (name === "actor") return 0;
  if (name === "target") return args.length >= 2 ? 1 : undefined;
  const argMatch = /^arg(\d+)$/.exec(name);
  if (argMatch) {
    const n = Number(argMatch[1]);
    if (Number.isInteger(n) && n >= 0 && n < args.length) return n;
    return undefined;
  }
  const idxMatch = /^(\d+)$/.exec(name);
  if (idxMatch) {
    const n = Number(idxMatch[1]);
    if (Number.isInteger(n) && n >= 1 && n <= args.length) return n - 1;
  }
  return undefined;
}

function renderTerm(term: language.Term, ctx: FormatContext): string {
  switch (term.kind) {
    case "identifier":
      if (term.id === ctx.config.player) return "you";
      return ctx.names.displayName(term.id);
    case "string":
      return term.value;
    case "number":
      return String(term.value);
    case "variable":
      return `?${term.id}`;
    case "wildcard":
      return "something";
    case "relationInstance":
      return term.atom.relation;
  }
}

function displayActionVerb(actionId: string): string {
  return defaultDisplayName(actionId);
}

// QueryConfig is imported only for type-driven config shape — silence unused if unused at runtime.
export type { QueryConfig };

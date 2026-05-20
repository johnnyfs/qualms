import { tool } from "ai";
import { z } from "zod";
import { language } from "@quealm/qualms";
import type { TranscriptEntry } from "../types.js";
import { formatEffect, formatPlayResult, formatProgramEffects } from "../format.js";

type StoryModel = language.StoryModel;
type Effect = language.Effect;
type GroundTerm = language.GroundTerm;

const {
  LanguageParseError,
  LanguageModelError,
  LanguageValidationFailedError,
  emitTopLevelStatement,
  languageRuntimeInternals,
  parseExpression,
  parseProgram,
  playLanguageCall,
  programFromModel,
} = language;

export interface CoauthorContext {
  readonly model: StoryModel;
  readonly append: (entries: readonly TranscriptEntry[]) => void;
  /** Resolved by the user's next input while a question is pending. */
  readonly askUser: (question: string) => Promise<string>;
}

interface ToolResult {
  readonly result: unknown;
  readonly transcript: readonly TranscriptEntry[];
}

type QueryRow = Record<string, unknown>;

export function buildTools(ctx: CoauthorContext) {
  return {
    query: tool({
      description:
        "Inspect the loaded story. Pass a DSL expression like 'At(?actor, ?room)' to get binding rows, or one of: 'show', 'show <kind>' (trait | relation | predicate | action | entity | rule | validation), 'show <kind> <name>'.",
      inputSchema: z.object({
        expr: z
          .string()
          .describe(
            "A DSL expression to evaluate, or a 'show' command. Use ?var for unbound variables.",
          ),
      }),
      execute: async ({ expr }) => {
        const trimmed = expr.trim();
        const entries: TranscriptEntry[] = [{ kind: "input", text: `? ${trimmed}` }];
        const show = parseShow(trimmed);
        if (show) {
          try {
            const definitions = showDefinitions(ctx.model, show.targetKind, show.name);
            const text = definitions.length > 0 ? definitions.join("\n\n") : "(no matches)";
            for (const line of text.split("\n")) {
              entries.push({ kind: "effect", text: line });
            }
            ctx.append(entries);
            return { kind: "show", definitions, count: definitions.length };
          } catch (err) {
            const message = errorMessage(err);
            entries.push({ kind: "error", text: `! ${message}` });
            ctx.append(entries);
            return { kind: "error", error: message };
          }
        }
        try {
          const parsed = parseExpression(trimmed);
          const envs = languageRuntimeInternals.evalExpression(ctx.model, parsed, {});
          const rows: QueryRow[] = envs.map(formatRow);
          entries.push({ kind: "feedback", text: renderRows(rows) });
          ctx.append(entries);
          return { kind: "query", expr: trimmed, count: rows.length, rows };
        } catch (err) {
          const message = errorMessage(err);
          const category = err instanceof LanguageParseError ? "parse" : "evaluate";
          entries.push({ kind: "error", text: `! ${category}: ${message}` });
          ctx.append(entries);
          return { kind: "error", category, error: message };
        }
      },
    }),

    play: tool({
      description:
        "Run an action call against the current world state, e.g. 'Go(Player, Outside)' or 'Open(Player, Bars)'. Returns 'succeed;' or 'fail { ... };' plus any effects.",
      inputSchema: z.object({
        call: z.string().describe("An action invocation in DSL, e.g. Go(Player, Cell)."),
      }),
      execute: async ({ call }) => {
        const trimmed = call.trim();
        const entries: TranscriptEntry[] = [{ kind: "input", text: `> ${trimmed}` }];
        try {
          const result = playLanguageCall(ctx.model, trimmed);
          entries.push(...formatPlayResult(result, ctx.model));
          ctx.append(entries);
          return {
            kind: "play",
            call: trimmed,
            status: result.status,
            feedback: result.feedback,
            effects: result.effects,
            failures: result.failures,
          };
        } catch (err) {
          const message = errorMessage(err);
          entries.push({ kind: "error", text: `! ${message}` });
          ctx.append(entries);
          return { kind: "error", error: message };
        }
      },
    }),

    mutate: tool({
      description:
        "Apply DSL top-level statements to the live story model. Includes 'begin;', 'commit;', and 'rollback;' for transaction control. On parse or model errors, the call is rejected atomically (no partial mutation inside an open transaction) and the error is returned for you to react to.",
      inputSchema: z.object({
        dsl: z
          .string()
          .describe("One or more DSL top-level statements. Terminate each with ';' where required."),
      }),
      execute: async ({ dsl }) => {
        const trimmed = dsl.trim();
        const entries: TranscriptEntry[] = [];
        for (const line of formatMutateInput(trimmed)) {
          entries.push({ kind: "input", text: line });
        }
        try {
          const effects: Effect[] = ctx.model.apply(parseProgram(trimmed));
          if (effects.length === 0) {
            entries.push({ kind: "feedback", text: "ok;" });
          } else {
            for (const effect of effects) {
              entries.push({ kind: "effect", text: formatEffect(effect, ctx.model) });
            }
          }
          ctx.append(entries);
          return {
            kind: "mutate",
            applied: true,
            effects: effects.map(describeEffect),
            inTransaction: ctx.model.inTransaction,
          };
        } catch (err) {
          if (err instanceof LanguageValidationFailedError) {
            for (const failure of err.failures) {
              entries.push({
                kind: "error",
                text: `! ${failure.validation}#${failure.assertion}: ${failure.message}`,
              });
            }
            ctx.append(entries);
            return {
              kind: "validation_failed",
              applied: false,
              inTransaction: ctx.model.inTransaction,
              failures: err.failures.map((failure) => ({ ...failure })),
            };
          }
          const category =
            err instanceof LanguageParseError
              ? "parse"
              : err instanceof LanguageModelError
              ? "model"
              : "internal";
          const message = errorMessage(err);
          entries.push({ kind: "error", text: `! ${category}: ${message}` });
          ctx.append(entries);
          return {
            kind: "error",
            applied: false,
            category,
            error: message,
            inTransaction: ctx.model.inTransaction,
          };
        }
      },
    }),

    ask_user: tool({
      description:
        "Ask the writer a clarifying question and wait for their reply. Use this only when intent is genuinely ambiguous; don't use it as filler.",
      inputSchema: z.object({
        question: z.string().describe("A single, focused clarifying question."),
      }),
      execute: async ({ question }) => {
        const trimmed = question.trim();
        ctx.append([{ kind: "info", text: `?? ${trimmed}` }]);
        const answer = await ctx.askUser(trimmed);
        return { kind: "answer", question: trimmed, answer };
      },
    }),
  } as const;
}

function describeEffect(effect: Effect): { polarity: string; relation: string; args: unknown[] } {
  return {
    polarity: effect.polarity,
    relation: effect.fact.relation,
    args: effect.fact.args.map(plainGroundTerm),
  };
}

function plainGroundTerm(term: GroundTerm): unknown {
  switch (term.kind) {
    case "id":
      return term.id;
    case "string":
      return term.value;
    case "number":
      return term.value;
    case "relation":
      return { relation: term.relation, args: term.args.map(plainGroundTerm) };
  }
}

function formatMutateInput(source: string): readonly string[] {
  return source
    .split("\n")
    .map((line) => `~ ${line}`)
    .filter((line, index, arr) => !(index === arr.length - 1 && line.trim() === "~"));
}

function formatRow(env: Record<string, GroundTerm>): QueryRow {
  const row: QueryRow = {};
  for (const [name, value] of Object.entries(env)) {
    row[name] = plainGroundTerm(value);
  }
  return row;
}

function renderRows(rows: readonly QueryRow[]): string {
  if (rows.length === 0) return "[];";
  return `${JSON.stringify(rows)};`;
}

interface ShowRequest {
  readonly targetKind: string;
  readonly name?: string;
}

function parseShow(expr: string): ShowRequest | undefined {
  const match = /^show(?:\s+([A-Za-z_][A-Za-z0-9_]*))?(?:\s+([A-Za-z_][A-Za-z0-9_]*))?\s*;?$/.exec(
    expr,
  );
  if (!match) return undefined;
  return {
    targetKind: match[1] ?? "all",
    ...(match[2] ? { name: match[2] } : {}),
  };
}

function showDefinitions(
  model: StoryModel,
  targetKind: string,
  name: string | undefined,
): string[] {
  const program = programFromModel(model);
  return program.statements
    .filter((statement) => {
      if (targetKind !== "all" && statement.kind !== targetKind) return false;
      if (!name) return true;
      return "id" in statement && statement.id === name;
    })
    .map(emitTopLevelStatement);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

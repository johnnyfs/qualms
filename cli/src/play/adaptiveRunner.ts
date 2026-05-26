import { streamText, stepCountIs, tool, type LanguageModel, type ModelMessage } from "ai";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { language } from "@quealm/qualms";
import type { CoauthorConfig } from "../coauthor/config.js";
import type { TranscriptEntry } from "../types.js";
import { formatEffect } from "../format.js";
import type { PlayConfig } from "./config.js";
import { buildNameIndex, type NameIndex } from "./naming.js";
import { buildVerbTable, type VerbTable } from "./verbs.js";
import { infocomView } from "./infocomView.js";
import { currentLocation, visibleEntities } from "./resolve.js";
import { formatResult } from "./resultFormatter.js";
import { buildAdaptiveSystemPrompt } from "./adaptivePrompt.js";

type StoryModel = language.StoryModel;
type GroundTerm = language.GroundTerm;
type RelationAtom = language.RelationAtom;

const { parseExpression, parseRelationAtom, playLanguageCall, playLanguageQuery } = language;
const STREAM_CHUNK_SIZE = 48;

export interface AdaptiveRunnerCallbacks {
  readonly append: (entries: readonly TranscriptEntry[]) => void;
}

export interface AdaptiveSession {
  readonly config: CoauthorConfig;
  readonly playConfig: PlayConfig;
  readonly model: StoryModel;
  readonly llm: LanguageModel;
  readonly messages: ModelMessage[];
  readonly names: NameIndex;
  readonly verbs: VerbTable;
  running: boolean;
  abort: AbortController | null;
  showTrace: boolean;
}

export interface CreateAdaptiveSessionOptions {
  readonly llm?: LanguageModel;
  readonly showTrace?: boolean;
}

export function createAdaptiveSession(
  model: StoryModel,
  config: CoauthorConfig,
  playConfig: PlayConfig,
  options: CreateAdaptiveSessionOptions = {},
): AdaptiveSession {
  return {
    config,
    playConfig,
    model,
    llm: options.llm ?? selectModel(config),
    messages: [],
    names: buildNameIndex(model, playConfig),
    verbs: buildVerbTable(model, playConfig),
    running: false,
    abort: null,
    showTrace: options.showTrace ?? false,
  };
}

export function setAdaptiveTrace(session: AdaptiveSession, showTrace: boolean): void {
  session.showTrace = showTrace;
}

export function openingSceneEntries(session: AdaptiveSession): readonly TranscriptEntry[] {
  return infocomView.renderTurn({
    model: session.model,
    config: session.playConfig,
    names: session.names,
    verbs: session.verbs,
  });
}

export async function handleAdaptiveInput(
  session: AdaptiveSession,
  text: string,
  callbacks: AdaptiveRunnerCallbacks,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  if (session.running) {
    callbacks.append([{ kind: "error", text: "The narrator is still responding." }]);
    return;
  }

  session.messages.push({ role: "user", content: trimmed });
  session.running = true;
  const abort = new AbortController();
  session.abort = abort;

  try {
    const result = streamText({
      model: session.llm,
      system: buildAdaptiveSystemPrompt(session.model, session.playConfig, session.names, session.verbs),
      messages: session.messages,
      tools: buildAdaptiveTools(session, callbacks),
      temperature: session.config.temperature,
      stopWhen: stepCountIs(session.config.maxSteps),
      abortSignal: abort.signal,
    });

    let textBuffer = "";
    const appendNarrative = (chunk: string) => {
      if (chunk.length > 0) callbacks.append([{ kind: "narrative", text: chunk }]);
    };
    const flushReadyLines = () => {
      while (true) {
        const newline = textBuffer.indexOf("\n");
        if (newline < 0) return;
        appendNarrative(textBuffer.slice(0, newline));
        textBuffer = textBuffer.slice(newline + 1);
      }
    };
    const flushPartialChunks = () => {
      flushReadyLines();
      while (textBuffer.length >= STREAM_CHUNK_SIZE) {
        const window = textBuffer.slice(0, STREAM_CHUNK_SIZE);
        const space = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
        const end = space >= Math.floor(STREAM_CHUNK_SIZE / 2) ? space : STREAM_CHUNK_SIZE;
        appendNarrative(textBuffer.slice(0, end).trimEnd());
        textBuffer = textBuffer.slice(end).replace(/^[ \t]+/, "");
        flushReadyLines();
      }
    };
    const flushText = () => {
      flushReadyLines();
      if (!textBuffer) return;
      appendNarrative(textBuffer);
      textBuffer = "";
    };

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          textBuffer += part.text;
          flushPartialChunks();
          break;
        case "text-end":
          flushText();
          break;
        case "tool-error": {
          const message = part.error instanceof Error ? part.error.message : String(part.error);
          callbacks.append([{ kind: "error", text: `! tool ${part.toolName}: ${message}` }]);
          break;
        }
        case "error": {
          const message = part.error instanceof Error ? part.error.message : String(part.error);
          callbacks.append([{ kind: "error", text: `! narrator: ${message}` }]);
          break;
        }
        case "abort":
          callbacks.append([{ kind: "info", text: "(narrator aborted)" }]);
          break;
        case "finish":
          flushText();
          break;
        default:
          break;
      }
    }

    const final = await result.response;
    for (const message of final.messages) session.messages.push(message);
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      callbacks.append([{ kind: "info", text: "(narrator aborted)" }]);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      callbacks.append([{ kind: "error", text: `! narrator: ${message}` }]);
    }
  } finally {
    session.running = false;
    session.abort = null;
  }
}

export function cancelAdaptive(session: AdaptiveSession): void {
  session.abort?.abort();
}

function selectModel(config: CoauthorConfig): LanguageModel {
  if (config.provider === "anthropic") {
    const provider = config.apiKey ? createAnthropic({ apiKey: config.apiKey }) : anthropic;
    return provider(config.model);
  }
  const provider = config.apiKey ? createOpenAI({ apiKey: config.apiKey }) : openai;
  return provider(config.model);
}

function buildAdaptiveTools(session: AdaptiveSession, callbacks: AdaptiveRunnerCallbacks) {
  const appendTrace = (entries: readonly TranscriptEntry[]) => {
    if (session.showTrace) callbacks.append(entries);
  };

  return {
    scene: tool({
      description:
        "Inspect the current location, visible entities, and available story verbs. Use this for look, inventory/context, and before narrating the opening or current scene.",
      inputSchema: z.object({}),
      execute: async () => {
        appendTrace([{ kind: "input", text: "? scene" }]);
        const location = currentLocation(session.model, session.playConfig);
        const visible = visibleEntities(session.model, session.playConfig);
        const entries = infocomView.renderTurn({
          model: session.model,
          config: session.playConfig,
          names: session.names,
          verbs: session.verbs,
        });
        appendTrace(entries.map((entry) => ({ ...entry, kind: entry.kind === "error" ? "error" : "effect" })));
        return {
          location,
          locationName: location ? session.names.displayName(location) : undefined,
          visible: visible.ids.map((id) => ({ id, name: session.names.displayName(id) })),
          usedVisibilityFallback: visible.usedFallback,
          actions: session.verbs
            .all()
            .filter((verb) => verb.kind === "action" && !verb.hidden)
            .map((verb) => ({ id: verb.actionId, words: verb.words })),
          sceneText: entries.map((entry) => entry.text).filter((line) => line.length > 0),
        };
      },
    }),

    query: tool({
      description:
        "Inspect story state without changing it. Use a DSL expression, or a named query call such as GetInventory(Player).",
      inputSchema: z.object({
        expr: z.string().describe("DSL expression or named query call."),
      }),
      execute: async ({ expr }) => {
        const trimmed = expr.trim();
        appendTrace([{ kind: "input", text: `? ${trimmed}` }]);
        try {
          const parsed = parseExpression(trimmed);
          if (parsed.kind === "relation" && session.model.queries.has(parsed.atom.relation)) {
            const result = playLanguageQuery(session.model, parsed.atom);
            appendTrace([{ kind: result.status === "passed" ? "feedback" : "error", text: queryFeedback(result) }]);
            return {
              kind: "named_query",
              status: result.status,
              outputs: result.outputs,
              bindings: result.bindings.map(formatBinding),
              reasons: result.reasons,
            };
          }
          const rows = language.languageRuntimeInternals.evalExpression(session.model, parsed, {});
          appendTrace([{ kind: "feedback", text: rows.length === 0 ? "[];" : `${rows.length} row(s);` }]);
          return {
            kind: "expression",
            status: "passed",
            bindings: rows.map(formatBinding),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendTrace([{ kind: "error", text: `! ${message}` }]);
          return { kind: "error", error: message };
        }
      },
    }),

    play_action: tool({
      description:
        "Run one declared story action. The call must be DSL like Open(Player, ActOne.Bars). This is the only way to change story state in adaptive play.",
      inputSchema: z.object({
        call: z.string().describe("A declared action invocation, e.g. Open(Player, ActOne.Bars)."),
      }),
      execute: async ({ call }) => {
        const trimmed = call.trim();
        appendTrace([{ kind: "input", text: `> ${trimmed}` }]);
        try {
          const atom = parseRelationAtom(trimmed);
          const result = playLanguageCall(session.model, atom);
          const human = formatResult(atom, {
            config: session.playConfig,
            names: session.names,
            verbs: session.verbs,
            model: session.model,
            result,
          });
          appendTrace([
            { kind: result.status === "passed" ? "feedback" : "error", text: result.feedback },
            ...result.effects.map((effect) => ({ kind: "effect" as const, text: formatEffect(effect, session.model) })),
          ]);
          return {
            kind: "play_action",
            call: trimmed,
            status: result.status,
            feedback: result.feedback,
            reasons: result.reasons,
            failures: result.failures,
            effects: result.effects.map((effect) => ({
              polarity: effect.polarity,
              relation: effect.fact.relation,
              args: effect.fact.args.map(plainGroundTerm),
            })),
            events: result.events.map((event) => ({
              event: event.event,
              args: event.args.map(plainGroundTerm),
            })),
            human,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendTrace([{ kind: "error", text: `! ${message}` }]);
          return { kind: "error", error: message };
        }
      },
    }),
  } as const;
}

function queryFeedback(result: language.LanguageQueryResult): string {
  if (result.status !== "passed") return `fail { ${result.reasons.join("; ")} }`;
  if (result.bindings.length === 0) return "[];";
  return `${result.bindings.length} row(s);`;
}

function formatBinding(binding: Record<string, GroundTerm>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(binding)) out[name] = plainGroundTerm(value);
  return out;
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

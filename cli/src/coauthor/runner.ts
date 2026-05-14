import { streamText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import type { language } from "@quealm/qualms";
import type { TranscriptEntry } from "../types.js";
import type { CoauthorConfig } from "./config.js";
import { buildSystemPrompt } from "./prompt.js";
import { buildTools, type CoauthorContext } from "./tools.js";

type StoryModel = language.StoryModel;

export interface CoauthorRunnerCallbacks {
  readonly append: (entries: readonly TranscriptEntry[]) => void;
  readonly setPendingQuestion: (question: string | null) => void;
}

interface PendingAnswer {
  readonly question: string;
  readonly resolve: (answer: string) => void;
}

export interface CoauthorSession {
  readonly config: CoauthorConfig;
  readonly model: StoryModel;
  readonly llm: LanguageModel;
  readonly messages: ModelMessage[];
  pending: PendingAnswer | null;
  running: boolean;
  abort: AbortController | null;
}

export interface CreateCoauthorSessionOptions {
  readonly llm?: LanguageModel;
}

export function createCoauthorSession(
  model: StoryModel,
  config: CoauthorConfig,
  options: CreateCoauthorSessionOptions = {},
): CoauthorSession {
  return {
    config,
    model,
    llm: options.llm ?? selectModel(config),
    messages: [],
    pending: null,
    running: false,
    abort: null,
  };
}

function selectModel(config: CoauthorConfig): LanguageModel {
  if (config.provider === "anthropic") {
    const provider = config.apiKey ? createAnthropic({ apiKey: config.apiKey }) : anthropic;
    return provider(config.model);
  }
  const provider = config.apiKey ? createOpenAI({ apiKey: config.apiKey }) : openai;
  return provider(config.model);
}

/**
 * Routes a user input either to resolve a pending clarifying question or to
 * kick off a fresh agent turn. Streams tool calls + narration into the
 * transcript as DSL lines.
 */
export async function handleCoauthorInput(
  session: CoauthorSession,
  text: string,
  callbacks: CoauthorRunnerCallbacks,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  if (session.pending) {
    const pending = session.pending;
    session.pending = null;
    callbacks.setPendingQuestion(null);
    pending.resolve(trimmed);
    return;
  }

  if (session.running) {
    callbacks.append([
      { kind: "error", text: "error: agent is busy; use /cancel to abort" },
    ]);
    return;
  }

  session.messages.push({ role: "user", content: trimmed });
  session.running = true;
  const abort = new AbortController();
  session.abort = abort;

  const ctx: CoauthorContext = {
    model: session.model,
    append: callbacks.append,
    askUser: (question) =>
      new Promise<string>((resolve) => {
        session.pending = { question, resolve };
        callbacks.setPendingQuestion(question);
      }),
  };

  try {
    const result = streamText({
      model: session.llm,
      system: buildSystemPrompt(),
      messages: session.messages,
      tools: buildTools(ctx),
      temperature: session.config.temperature,
      stopWhen: stepCountIs(session.config.maxSteps),
      abortSignal: abort.signal,
    });

    let textBuffer = "";
    const flushText = () => {
      if (textBuffer.length === 0) return;
      const lines = textBuffer.split("\n");
      for (const line of lines) {
        if (line.length === 0) continue;
        callbacks.append([{ kind: "narrative", text: line }]);
      }
      textBuffer = "";
    };

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          textBuffer += part.text;
          if (textBuffer.includes("\n")) {
            const lastNewline = textBuffer.lastIndexOf("\n");
            const ready = textBuffer.slice(0, lastNewline);
            textBuffer = textBuffer.slice(lastNewline + 1);
            for (const line of ready.split("\n")) {
              if (line.length === 0) continue;
              callbacks.append([{ kind: "narrative", text: line }]);
            }
          }
          break;
        case "text-end":
          flushText();
          break;
        case "tool-call":
          // Tool inputs render via each tool's execute (it pushes its own
          // transcript entries). Nothing to do here.
          break;
        case "tool-result":
          // Tool results were already rendered by execute. Nothing to do here.
          break;
        case "tool-error": {
          const message =
            part.error instanceof Error ? part.error.message : String(part.error);
          callbacks.append([{ kind: "error", text: `! tool ${part.toolName}: ${message}` }]);
          break;
        }
        case "error": {
          const message =
            part.error instanceof Error ? part.error.message : String(part.error);
          callbacks.append([{ kind: "error", text: `! ${message}` }]);
          break;
        }
        case "abort":
          callbacks.append([{ kind: "info", text: "(agent aborted)" }]);
          break;
        case "finish":
          flushText();
          break;
        default:
          break;
      }
    }

    const final = await result.response;
    for (const message of final.messages) {
      session.messages.push(message);
    }
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      callbacks.append([{ kind: "info", text: "(agent aborted)" }]);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      callbacks.append([{ kind: "error", text: `! agent: ${message}` }]);
    }
  } finally {
    session.running = false;
    session.abort = null;
  }
}

export function cancelCoauthor(
  session: CoauthorSession,
  callbacks: CoauthorRunnerCallbacks,
): void {
  if (session.pending) {
    const pending = session.pending;
    session.pending = null;
    callbacks.setPendingQuestion(null);
    pending.resolve("");
    return;
  }
  if (session.abort) {
    session.abort.abort();
  }
}

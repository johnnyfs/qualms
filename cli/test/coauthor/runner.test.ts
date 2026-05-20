import { describe, expect, it } from "vitest";
import { language } from "@quealm/qualms";
import type { LanguageModel } from "ai";
import {
  createCoauthorSession,
  handleCoauthorInput,
} from "../../src/coauthor/runner.js";
import type { CoauthorConfig } from "../../src/coauthor/config.js";
import type { TranscriptEntry } from "../../src/types.js";

type StreamPart = Record<string, unknown>;

const config: CoauthorConfig = {
  provider: "anthropic",
  model: "test-model",
  apiKey: "test-key",
  temperature: 0,
  maxSteps: 6,
};

function freshModel(): InstanceType<typeof language.StoryModel> {
  const model = new language.StoryModel();
  model.apply(
    language.parseProgram(`
      trait Actor
      trait Locatable
      trait Location

      relation At(subject: Locatable, location: Location) unique(subject)

      entity Player { Actor, Locatable }
      entity Cell { Location }

      set { At(Player, Cell); }
    `),
  );
  return model;
}

function textStep(text: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    { type: "text-delta", id: "0", delta: text },
    { type: "text-end", id: "0" },
    {
      type: "finish",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    },
  ];
}

function toolCallStep(toolName: string, input: object, id: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-call",
      toolCallId: id,
      toolName,
      input: JSON.stringify(input),
    },
    {
      type: "finish",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: "tool-calls",
    },
  ];
}

function streamFrom(parts: StreamPart[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function scriptedLm(steps: StreamPart[][]): LanguageModel {
  const queue = [...steps];
  const mock = {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-1",
    supportedUrls: {},
    async doGenerate() {
      throw new Error("doGenerate not used");
    },
    async doStream() {
      const next = queue.shift();
      if (!next) throw new Error("mock LM ran out of scripted steps");
      return { stream: streamFrom(next) };
    },
  };
  return mock as unknown as LanguageModel;
}

describe("coauthor runner", () => {
  it("streams long prose without waiting for a newline", async () => {
    const model = freshModel();
    const llm = scriptedLm([
      textStep(
        "This is a deliberately long coauthor response with no newline so it should be appended in chunks while the stream is still active.",
      ),
    ]);
    const session = createCoauthorSession(model, config, { llm });
    const transcript: TranscriptEntry[] = [];
    await handleCoauthorInput(session, "Explain the current room.", {
      append: (entries) => transcript.push(...entries),
      setPendingQuestion: () => {},
    });

    const narrative = transcript.filter((e) => e.kind === "narrative");
    expect(narrative.length).toBeGreaterThan(1);
    expect(narrative.map((e) => e.text).join(" ")).toContain(
      "deliberately long coauthor response",
    );
  });

  it("streams a tool call as DSL transcript entries", async () => {
    const model = freshModel();
    const llm = scriptedLm([
      toolCallStep("query", { expr: "At(?actor, ?room)" }, "c1"),
      textStep("Player is in the Cell."),
    ]);
    const session = createCoauthorSession(model, config, { llm });
    const transcript: TranscriptEntry[] = [];
    await handleCoauthorInput(session, "Where is the player?", {
      append: (entries) => transcript.push(...entries),
      setPendingQuestion: () => {},
    });

    expect(
      transcript.some((e) => e.kind === "input" && e.text.includes("? At(?actor, ?room)")),
    ).toBe(true);
    expect(transcript.some((e) => e.kind === "feedback" && e.text.includes("Player"))).toBe(true);
    expect(transcript.some((e) => e.kind === "narrative" && e.text.includes("Player"))).toBe(true);
  });

  it("routes a clarifying question through askUser and resumes", async () => {
    const model = freshModel();
    const llm = scriptedLm([
      toolCallStep("ask_user", { question: "Which room?" }, "c1"),
      textStep("Thanks."),
    ]);
    const session = createCoauthorSession(model, config, { llm });
    const transcript: TranscriptEntry[] = [];
    let pendingSeen: string | null = null;
    const callbacks = {
      append: (entries: readonly TranscriptEntry[]) => transcript.push(...entries),
      setPendingQuestion: (q: string | null) => {
        if (q !== null) pendingSeen = q;
      },
    };

    const turn = handleCoauthorInput(session, "Tell me about the rooms.", callbacks);

    // Give the tool a chance to fire and register a pending question.
    for (let i = 0; i < 10 && pendingSeen === null; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(pendingSeen).toBe("Which room?");

    // User answers; the runner resolves the pending promise and the turn continues.
    await handleCoauthorInput(session, "The Cell.", callbacks);
    await turn;

    expect(transcript.some((e) => e.kind === "info" && e.text === "?? Which room?")).toBe(true);
    expect(transcript.some((e) => e.kind === "narrative" && e.text.includes("Thanks"))).toBe(true);
  });

  it("applies mutate tool calls against the live model and surfaces begin/commit", async () => {
    const model = freshModel();
    const llm = scriptedLm([
      toolCallStep("mutate", { dsl: "begin;" }, "c1"),
      toolCallStep("mutate", { dsl: "set { At(Player, Cell); }" }, "c2"),
      toolCallStep("mutate", { dsl: "commit;" }, "c3"),
      textStep("Done."),
    ]);
    const session = createCoauthorSession(model, config, { llm });
    const transcript: TranscriptEntry[] = [];
    await handleCoauthorInput(session, "Make sure the player is in the Cell.", {
      append: (entries) => transcript.push(...entries),
      setPendingQuestion: () => {},
    });

    expect(model.inTransaction).toBe(false);
    expect(transcript.some((e) => e.kind === "input" && e.text === "begin;")).toBe(true);
    expect(transcript.some((e) => e.kind === "input" && e.text === "commit;")).toBe(true);
  });
});

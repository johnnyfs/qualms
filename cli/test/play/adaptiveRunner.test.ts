import { describe, expect, it } from "vitest";
import { language } from "@quealm/qualms";
import type { LanguageModel } from "ai";
import type { CoauthorConfig } from "../../src/coauthor/config.js";
import type { TranscriptEntry } from "../../src/types.js";
import { parsePlayConfig } from "../../src/play/config.js";
import {
  createAdaptiveSession,
  handleAdaptiveInput,
  openingSceneEntries,
  setAdaptiveTrace,
} from "../../src/play/adaptiveRunner.js";

type StreamPart = Record<string, unknown>;

const agentConfig: CoauthorConfig = {
  provider: "anthropic",
  model: "test-model",
  apiKey: "test-key",
  temperature: 0,
  maxSteps: 6,
};

const playConfig = parsePlayConfig(`
player: Player
descriptions:
  Cell: "A narrow stone cell."
presentations:
  Bars: "Iron bars block the corridor."
`);

function freshModel(): InstanceType<typeof language.StoryModel> {
  return language.loadStoryProgram(`
    trait Actor
    trait Locatable
    trait Location
    trait Openable

    relation At(subject: Locatable, location: Location) unique(subject)
    relation Opened(Openable)

    action Open(actor: Actor, door: Openable) {
      when (!Opened(door)) { set Opened(door) }
    }

    entity Player { Actor, Locatable }
    entity Cell { Location }
    entity Bars { Openable, Locatable }

    set {
      At(Player, Cell);
      At(Bars, Cell);
    }
  `);
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

describe("adaptive play runner", () => {
  it("renders an opening scene without invoking the model", () => {
    const session = createAdaptiveSession(freshModel(), agentConfig, playConfig, {
      llm: scriptedLm([]),
    });
    const entries = openingSceneEntries(session);

    expect(entries.some((entry) => entry.kind === "title" && entry.text === "Cell")).toBe(true);
    expect(entries.some((entry) => entry.text === "A narrow stone cell.")).toBe(true);
    expect(entries.some((entry) => entry.text === "Iron bars block the corridor.")).toBe(true);
  });

  it("plays actions while keeping DSL trace hidden by default", async () => {
    const model = freshModel();
    const session = createAdaptiveSession(model, agentConfig, playConfig, {
      llm: scriptedLm([
        toolCallStep("play_action", { call: "Open(Player, Bars)" }, "c1"),
        textStep("The bars swing open."),
      ]),
    });
    const transcript: TranscriptEntry[] = [];

    await handleAdaptiveInput(session, "open the bars", {
      append: (entries) => transcript.push(...entries),
    });

    expect(model.hasFact("Opened", [{ kind: "id", id: "Bars" }])).toBe(true);
    expect(transcript.some((entry) => entry.kind === "input" && entry.text.includes("Open"))).toBe(false);
    expect(transcript.some((entry) => entry.kind === "narrative" && entry.text.includes("bars"))).toBe(true);
  });

  it("shows DSL trace when enabled", async () => {
    const session = createAdaptiveSession(freshModel(), agentConfig, playConfig, {
      llm: scriptedLm([
        toolCallStep("play_action", { call: "Open(Player, Bars)" }, "c1"),
        textStep("Opened."),
      ]),
    });
    setAdaptiveTrace(session, true);
    const transcript: TranscriptEntry[] = [];

    await handleAdaptiveInput(session, "open the bars", {
      append: (entries) => transcript.push(...entries),
    });

    expect(transcript.some((entry) => entry.kind === "input" && entry.text === "> Open(Player, Bars)")).toBe(true);
    expect(transcript.some((entry) => entry.kind === "effect" && entry.text.includes("Opened(Bars)"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { language } from "@quealm/qualms";
import { buildTools, type CoauthorContext } from "../../src/coauthor/tools.js";
import type { TranscriptEntry } from "../../src/types.js";

function freshModel(): InstanceType<typeof language.StoryModel> {
  const model = new language.StoryModel();
  model.apply(
    language.parseProgram(`
      trait Actor
      trait Locatable
      trait Location

      relation At(subject: Locatable, location: Location) unique(subject)
      relation Path(Location, Location)

      action Go(actor: (Actor & Locatable) { At(actor, ?here) }, target: Location) {
        when (Path(?here, target)) {
          set At(actor, target)
        }
      }

      entity Cell { Location }
      entity Outside { Location }
      entity Player { Actor, Locatable }

      set {
        Path(Cell, Outside);
        Path(Outside, Cell);
        At(Player, Cell);
      }
    `),
  );
  return model;
}

function makeCtx(model: InstanceType<typeof language.StoryModel>): {
  ctx: CoauthorContext;
  transcript: TranscriptEntry[];
} {
  const transcript: TranscriptEntry[] = [];
  const ctx: CoauthorContext = {
    model,
    append: (entries) => transcript.push(...entries),
    askUser: async () => "",
  };
  return { ctx, transcript };
}

describe("coauthor tools", () => {
  it("query renders the DSL expression and JSON rows", async () => {
    const model = freshModel();
    const { ctx, transcript } = makeCtx(model);
    const tools = buildTools(ctx);
    const result = (await tools.query.execute!(
      { expr: "At(?actor, ?room)" },
      { toolCallId: "1", messages: [] },
    )) as { kind: string; rows: unknown[] };
    expect(result.kind).toBe("query");
    expect(result.rows).toEqual([{ actor: "Player", room: "Cell" }]);
    expect(transcript[0]).toEqual({ kind: "input", text: "? At(?actor, ?room)" });
    expect(transcript[1]?.kind).toBe("feedback");
    expect(transcript[1]?.text).toContain("Player");
  });

  it("query show prints relation definitions", async () => {
    const model = freshModel();
    const { ctx, transcript } = makeCtx(model);
    const tools = buildTools(ctx);
    const result = (await tools.query.execute!(
      { expr: "show relation At" },
      { toolCallId: "1", messages: [] },
    )) as { kind: string; count: number };
    expect(result.kind).toBe("show");
    expect(result.count).toBe(1);
    expect(transcript[0]).toEqual({ kind: "input", text: "? show relation At" });
    expect(transcript[1]?.text).toContain("relation At");
  });

  it("play executes an action and reports succeed;", async () => {
    const model = freshModel();
    const { ctx, transcript } = makeCtx(model);
    const tools = buildTools(ctx);
    const result = (await tools.play.execute!(
      { call: "Go(Player, Outside)" },
      { toolCallId: "1", messages: [] },
    )) as { kind: string; status: string };
    expect(result.kind).toBe("play");
    expect(result.status).toBe("passed");
    expect(transcript[0]).toEqual({ kind: "input", text: "> Go(Player, Outside)" });
    expect(transcript[1]?.text).toBe("succeed;");
    expect(model.hasFact("At", [{ kind: "id", id: "Player" }, { kind: "id", id: "Outside" }])).toBe(
      true,
    );
  });

  it("mutate applies tx statements and reports counts via inTransaction flag", async () => {
    const model = freshModel();
    const { ctx, transcript } = makeCtx(model);
    const tools = buildTools(ctx);

    const begin = (await tools.mutate.execute!(
      { dsl: "begin;" },
      { toolCallId: "1", messages: [] },
    )) as { kind: string; inTransaction: boolean };
    expect(begin.kind).toBe("mutate");
    expect(begin.inTransaction).toBe(true);

    const set = (await tools.mutate.execute!(
      { dsl: "set { !At(Player, Cell); At(Player, Outside); }" },
      { toolCallId: "2", messages: [] },
    )) as { kind: string; inTransaction: boolean };
    expect(set.inTransaction).toBe(true);
    expect(model.hasFact("At", [{ kind: "id", id: "Player" }, { kind: "id", id: "Outside" }])).toBe(
      true,
    );
    expect(transcript.some((e) => e.kind === "effect" && e.text.includes("Outside"))).toBe(true);

    const commit = (await tools.mutate.execute!(
      { dsl: "commit;" },
      { toolCallId: "3", messages: [] },
    )) as { kind: string; inTransaction: boolean };
    expect(commit.inTransaction).toBe(false);
  });

  it("mutate reports validation failures without closing the transaction", async () => {
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

        validation PlayerInCell {
          assert fact At(Player, Cell);
        }
      `),
    );
    const { ctx } = makeCtx(model);
    const tools = buildTools(ctx);

    await tools.mutate.execute!({ dsl: "begin;" }, { toolCallId: "1", messages: [] });
    await tools.mutate.execute!(
      { dsl: "set { !At(Player, Cell); }" },
      { toolCallId: "2", messages: [] },
    );
    const commit = (await tools.mutate.execute!(
      { dsl: "commit;" },
      { toolCallId: "3", messages: [] },
    )) as { kind: string; inTransaction: boolean; failures?: unknown[] };
    expect(commit.kind).toBe("validation_failed");
    expect(commit.inTransaction).toBe(true);
    expect(commit.failures?.length).toBeGreaterThan(0);
  });

  it("ask_user posts a question and resolves with the user's reply", async () => {
    const model = freshModel();
    const transcript: TranscriptEntry[] = [];
    let resolver: ((s: string) => void) | undefined;
    const ctx: CoauthorContext = {
      model,
      append: (entries) => transcript.push(...entries),
      askUser: (question) => {
        transcript.push({ kind: "info", text: `(asked: ${question})` });
        return new Promise<string>((resolve) => {
          resolver = resolve;
        });
      },
    };
    const tools = buildTools(ctx);
    const pending = tools.ask_user.execute!(
      { question: "What is the cell made of?" },
      { toolCallId: "1", messages: [] },
    );
    expect(transcript.some((e) => e.text === "?? What is the cell made of?")).toBe(true);
    resolver?.("damp granite");
    const result = (await pending) as { kind: string; answer: string };
    expect(result.kind).toBe("answer");
    expect(result.answer).toBe("damp granite");
  });
});

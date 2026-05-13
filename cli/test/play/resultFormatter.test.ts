import { describe, expect, it } from "vitest";
import { language } from "@quealm/qualms";
import { buildNameIndex } from "../../src/play/naming.js";
import { buildVerbTable } from "../../src/play/verbs.js";
import { defaultPlayConfig, parsePlayConfig } from "../../src/play/config.js";
import { formatResult } from "../../src/play/resultFormatter.js";

const { loadStoryProgram } = language;

const SOURCE = `
  trait Actor
  trait Locatable
  trait Location
  trait Portable
  trait Key
  trait Lockable
  trait Openable
  trait Speaker
  trait Topic
  relation At(subject: Locatable, location: Location) unique(subject)
  relation Path(Location, Location)
  relation Carrying(Actor, Portable)
  relation Locked(Lockable)
  relation Opened(Openable)
  relation LockedWith(Lockable, Key)
  relation TalksAbout(Speaker, Topic)
  action Take(actor: Actor, target: Portable) { when (Carrying(actor, target)) { succeed; } }
  action Go(actor: Actor, target: Location) { succeed; }
  action TalkAbout(actor: Actor, speaker: Speaker, topic: Topic) {
    when (TalksAbout(speaker, topic)) { succeed; }
  }
  action Unlock(actor: Actor, door: Lockable, key: Key) { succeed; }
  query Inventory(actor: Actor) {
    Carrying(actor, ?item)
  }
  entity Player { Actor, Locatable }
  entity Cell { Location }
  entity Corridor { Location }
  entity BoneShard { Portable, Locatable }
  entity MasterKey { Key, Portable, Locatable }
  entity Bars { Lockable, Openable, Locatable }
  entity Guard { Speaker }
  entity Bribery { Topic }
`;

function setup(configText = "") {
  const model = loadStoryProgram(SOURCE);
  const config = configText ? parsePlayConfig(configText) : defaultPlayConfig();
  const names = buildNameIndex(model, config);
  const verbs = buildVerbTable(model, config);
  const baseCtx = { config, names, verbs, model };
  return {
    model,
    success: (atom: language.RelationAtom, result: language.LanguagePlayResult) =>
      formatResult(atom, { ...baseCtx, result }),
    fail: (atom: language.RelationAtom, reasons: readonly string[]) => {
      const result: language.LanguagePlayResult = {
        status: "failed",
        feedback: `fail { ${reasons.map((r) => `${r};`).join(" ")} }`,
        reasons,
        effects: [],
        events: [],
        failures: reasons.map((message) => ({ kind: "condition", message })),
      };
      return formatResult(atom, { ...baseCtx, result });
    },
    query: (atom: language.RelationAtom, queryResult: language.LanguageQueryResult) =>
      formatResult(atom, { ...baseCtx, queryResult }),
  };
}

function passed(events: language.LanguageEvent[] = []): language.LanguagePlayResult {
  return {
    status: "passed",
    feedback: "succeed;",
    reasons: [],
    effects: [],
    events,
    failures: [],
  };
}

describe("formatResult — success", () => {
  it("uses built-in Take template", () => {
    const f = setup();
    expect(
      f.success(
        {
          relation: "Take",
          args: [
            { kind: "identifier", id: "Player" },
            { kind: "identifier", id: "BoneShard" },
          ],
        },
        passed(),
      ),
    ).toBe("You take the bone shard.");
  });

  it("uses Unlock built-in with two object args", () => {
    const f = setup();
    expect(
      f.success(
        {
          relation: "Unlock",
          args: [
            { kind: "identifier", id: "Player" },
            { kind: "identifier", id: "Bars" },
            { kind: "identifier", id: "MasterKey" },
          ],
        },
        passed(),
      ),
    ).toBe("You unlock the bars with the master key.");
  });

  it("verb config template overrides the built-in", () => {
    const f = setup(`
verbs:
  Take: { words: [take], template: "You snatch the $target." }
`);
    expect(
      f.success(
        {
          relation: "Take",
          args: [
            { kind: "identifier", id: "Player" },
            { kind: "identifier", id: "BoneShard" },
          ],
        },
        passed(),
      ),
    ).toBe("You snatch the bone shard.");
  });

  it("event template wins over verb template", () => {
    const f = setup(`
events:
  Took: "$actor pockets the $arg1."
verbs:
  Take: { words: [take], template: "snatched" }
`);
    expect(
      f.success(
        {
          relation: "Take",
          args: [
            { kind: "identifier", id: "Player" },
            { kind: "identifier", id: "BoneShard" },
          ],
        },
        passed([
          {
            event: "Took",
            args: [
              { kind: "id", id: "Player" },
              { kind: "id", id: "BoneShard" },
            ],
          },
        ]),
      ),
    ).toBe("you pockets the bone shard.");
  });

  it("falls back to action-id verb form for unknown action", () => {
    const f = setup();
    expect(
      f.success(
        {
          relation: "Frobnicate",
          args: [{ kind: "identifier", id: "Player" }],
        },
        passed(),
      ),
    ).toBe("You frobnicate.");
  });
});

describe("formatResult — failure", () => {
  it("translates !Carrying reason", () => {
    const f = setup();
    const text = f.fail(
      {
        relation: "Unlock",
        args: [
          { kind: "identifier", id: "Player" },
          { kind: "identifier", id: "Bars" },
          { kind: "identifier", id: "MasterKey" },
        ],
      },
      ["!Carrying(Player, MasterKey)"],
    );
    expect(text).toBe("You aren't carrying the master key.");
  });

  it("translates !Path reason", () => {
    const f = setup();
    const text = f.fail(
      {
        relation: "Go",
        args: [
          { kind: "identifier", id: "Player" },
          { kind: "identifier", id: "Outside" },
        ],
      },
      ["!Path(Cell, Outside)"],
    );
    expect(text).toBe("There's no path from cell to outside.");
  });

  it("translates Locked positive reason", () => {
    const f = setup();
    const text = f.fail(
      {
        relation: "Open",
        args: [
          { kind: "identifier", id: "Player" },
          { kind: "identifier", id: "Bars" },
        ],
      },
      ["Locked(Bars)"],
    );
    expect(text).toBe("The bars is locked.");
  });

  it("maps !Action(args) reasons via built-in denial templates", () => {
    const f = setup();
    const text = f.fail(
      {
        relation: "Unlock",
        args: [
          { kind: "identifier", id: "Player" },
          { kind: "identifier", id: "Bars" },
          { kind: "identifier", id: "BoneShard" },
        ],
      },
      ["!Unlock(Player, Bars, BoneShard)"],
    );
    expect(text).toBe("You can't unlock the bars with the bone shard.");
  });

  it("uses verb-level denialTemplate override", () => {
    const f = setup(`
verbs:
  Take: { words: [take], denialTemplate: "The $target slips your grasp." }
`);
    const text = f.fail(
      {
        relation: "Take",
        args: [
          { kind: "identifier", id: "Player" },
          { kind: "identifier", id: "Bribery" },
        ],
      },
      ["!Take(Player, Bribery)"],
    );
    expect(text).toBe("The bribery slips your grasp.");
  });

  it("falls back to 'You can't do that.' for unknown reasons", () => {
    const f = setup();
    expect(
      f.fail(
        {
          relation: "Take",
          args: [{ kind: "identifier", id: "Player" }],
        },
        ["!Mystery(Foo)"],
      ),
    ).toBe("You can't do that.");
    expect(
      f.fail(
        {
          relation: "Take",
          args: [{ kind: "identifier", id: "Player" }],
        },
        [],
      ),
    ).toBe("You can't do that.");
  });

  it("uses 'you' for the configured player in templates", () => {
    const f = setup();
    const text = f.fail(
      { relation: "X", args: [] },
      ["!At(Player, Cell)"],
    );
    expect(text).toBe("you isn't at cell.");
  });
});

describe("formatResult — query", () => {
  function queryResult(
    bindings: language.LanguageQueryResult["bindings"],
    outputs: readonly string[] = ["item"],
  ): language.LanguageQueryResult {
    return {
      status: "passed",
      bindings,
      outputs,
      reasons: [],
      failures: [],
    };
  }

  it("uses the built-in Inventory template with comma-joined items", () => {
    const f = setup();
    const text = f.query(
      { relation: "Inventory", args: [{ kind: "identifier", id: "Player" }] },
      queryResult([
        { item: { kind: "id", id: "BoneShard" } },
        { item: { kind: "id", id: "MasterKey" } },
      ]),
    );
    expect(text).toBe("You're carrying the bone shard, the master key.");
  });

  it("uses the Inventory empty default", () => {
    const f = setup();
    const text = f.query(
      { relation: "Inventory", args: [{ kind: "identifier", id: "Player" }] },
      queryResult([]),
    );
    expect(text).toBe("You're empty-handed.");
  });

  it("applies config.queries overrides", () => {
    const f = setup(`
queries:
  Inventory:
    template: "Your sack holds $items."
    empty: "Your sack is empty."
    item: "a $item"
    join: " and "
`);
    const text = f.query(
      { relation: "Inventory", args: [{ kind: "identifier", id: "Player" }] },
      queryResult([
        { item: { kind: "id", id: "BoneShard" } },
        { item: { kind: "id", id: "MasterKey" } },
      ]),
    );
    expect(text).toBe("Your sack holds a bone shard and a master key.");
  });
});

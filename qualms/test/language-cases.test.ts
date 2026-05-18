import { describe, expect, it } from "vitest";
import { language } from "../src/index.js";

const {
  LanguageModelError,
  emitProgram,
  emitStoryModel,
  idTerm,
  loadStoryProgram,
  parseProgram,
  playLanguageCall,
} = language;

describe("action cases", () => {
  it("parses and emits named case declarations", () => {
    const program = parseProgram(`
      trait Actor
      trait Item
      action Take(actor: Actor, target: Item) { succeed; }
      case Take(actor: Actor, target: Item) as TakeDefault {
        succeed;
      }
    `);

    const actionCase = program.statements.find((statement) => statement.kind === "case");
    expect(actionCase).toMatchObject({
      kind: "case",
      target: "Take",
      id: "TakeDefault",
    });
    expect(emitProgram(program)).toContain("case Take(actor: Actor, target: Item) as TakeDefault");
  });

  it("assigns generated ids to anonymous cases in canonical model output", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Item
      action Take(actor: Actor, target: Item) { succeed; }
      case Take(actor: Actor, target: Item) {
        succeed;
      }
      entity Player { Actor }
      entity Coin { Item }
    `);

    expect(model.actionCases[0]?.id).toBe("Take_0001");
    expect(emitStoryModel(model)).toContain("case Take(actor: Actor, target: Item) as Take_0001");
  });

  it("keeps the action body before extension cases", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Item
      relation Marked(Item)

      action Touch(actor: Actor, target: Item) {
        set Marked(target)
      }

      case Touch(actor: Actor, target: Item) as TouchFallback {
        set Marked(Spare)
      }

      entity Player { Actor }
      entity Gem { Item }
      entity Spare { Item }
    `);

    expect(playLanguageCall(model, "Touch(Player, Gem)").status).toBe("passed");
    expect(model.hasFact("Marked", [idTerm("Gem")])).toBe(true);
    expect(model.hasFact("Marked", [idTerm("Spare")])).toBe(false);
  });

  it("runs matching cases after the action body fails and then runs after rules", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Item
      trait Ethereal

      relation Reachable(Actor, Item)
      relation Carrying(Actor, Item)
      relation AfterRan(Item)

      action Take(actor: Actor, target: Item) {
        when (Reachable(actor, target)) {
          set Carrying(actor, target)
        }
      }

      case Take(actor: Actor, target: (Item & Ethereal)) as TakeEthereal {
        set Carrying(actor, target)
      }

      after Take(_, target: Item) {
        set AfterRan(target)
      }

      entity Player { Actor }
      entity GhostCoin { Item, Ethereal }
    `);

    expect(playLanguageCall(model, "Take(Player, GhostCoin)").status).toBe("passed");
    expect(model.hasFact("Carrying", [idTerm("Player"), idTerm("GhostCoin")])).toBe(true);
    expect(model.hasFact("AfterRan", [idTerm("GhostCoin")])).toBe(true);
  });

  it("lets before rules preempt cases", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Item
      relation Blocked(Item)
      relation Taken(Item)

      action Take(actor: Actor, target: Item) {
        when (!Blocked(target)) {
          set Taken(target)
        }
      }

      before Take(_, target: Item) {
        when (Blocked(target)) {
          fail;
        }
      }

      case Take(actor: Actor, target: Item) as TakeBlockedAnyway {
        set Taken(target)
      }

      entity Player { Actor }
      entity Gem { Item }
      set Blocked(Gem)
    `);

    expect(playLanguageCall(model, "Take(Player, Gem)").status).toBe("failed");
    expect(model.hasFact("Taken", [idTerm("Gem")])).toBe(false);
  });

  it("runs cases in declaration order", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Item
      relation Missing(Actor, Item)
      relation Picked(Item)

      action Pick(actor: Actor, target: Item) {
        when (Missing(actor, target)) {
          succeed;
        }
      }

      case Pick(actor: Actor, target: Item) as PickFirst {
        set Picked(First)
      }

      case Pick(actor: Actor, target: Item) as PickSecond {
        set Picked(Second)
      }

      entity Player { Actor }
      entity Gem { Item }
      entity First { Item }
      entity Second { Item }
    `);

    expect(playLanguageCall(model, "Pick(Player, Gem)").status).toBe("passed");
    expect(model.hasFact("Picked", [idTerm("First")])).toBe(true);
    expect(model.hasFact("Picked", [idTerm("Second")])).toBe(false);
  });

  it("tries later candidate environments within one case", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Item
      relation Missing(Actor, Item)
      relation Alias(Item, Item)
      relation Marked(Item)

      action Pick(actor: Actor, target: Item) {
        when (Missing(actor, target)) {
          succeed;
        }
      }

      case Pick(actor: Actor, target: Item { Alias(target, ?actual) }) as PickAlias {
        when (?actual == Right) {
          set Marked(?actual)
        }
      }

      entity Player { Actor }
      entity Gem { Item }
      entity Wrong { Item }
      entity Right { Item }
      set {
        Alias(Gem, Wrong);
        Alias(Gem, Right);
      }
    `);

    expect(playLanguageCall(model, "Pick(Player, Gem)").status).toBe("passed");
    expect(model.hasFact("Marked", [idTerm("Right")])).toBe(true);
  });

  it("replaces and undefines cases by id", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Item
      relation Missing(Actor, Item)
      relation Carrying(Actor, Item)
      relation Marked(Item)

      action Take(actor: Actor, target: Item) {
        when (Missing(actor, target)) {
          succeed;
        }
      }

      case Take(actor: Actor, target: Item) as TakeFallback {
        set Carrying(actor, target)
      }

      replace case TakeFallback {
        set Marked(target)
      }

      entity Player { Actor }
      entity Gem { Item }
    `);

    expect(playLanguageCall(model, "Take(Player, Gem)").status).toBe("passed");
    expect(model.hasFact("Carrying", [idTerm("Player"), idTerm("Gem")])).toBe(false);
    expect(model.hasFact("Marked", [idTerm("Gem")])).toBe(true);

    model.apply(parseProgram("undef case TakeFallback"));
    expect(playLanguageCall(model, "Take(Player, Gem)").status).toBe("failed");
  });

  it("can replace a case's parameter patterns", () => {
    const model = loadStoryProgram(`
      trait Actor
      trait Item
      trait Special
      relation Missing(Actor, Item)
      relation Marked(Item)

      action Take(actor: Actor, target: Item) {
        when (Missing(actor, target)) {
          succeed;
        }
      }

      case Take(actor: Actor, target: Item) as TakeFallback {
        set Marked(Spare)
      }

      replace case TakeFallback(actor: Actor, target: (Item & Special)) {
        set Marked(target)
      }

      entity Player { Actor }
      entity Gem { Item }
      entity GhostGem { Item, Special }
      entity Spare { Item }
    `);

    expect(playLanguageCall(model, "Take(Player, Gem)").status).toBe("failed");
    expect(playLanguageCall(model, "Take(Player, GhostGem)").status).toBe("passed");
    expect(model.hasFact("Marked", [idTerm("GhostGem")])).toBe(true);
    expect(model.hasFact("Marked", [idTerm("Spare")])).toBe(false);
  });

  it("validates case targets, arity, duplicate ids, and missing mutations", () => {
    expect(() =>
      loadStoryProgram(`
        trait Item
        case Missing(target: Item) as MissingCase { succeed; }
      `),
    ).toThrow(LanguageModelError);

    expect(() =>
      loadStoryProgram(`
        trait Actor
        trait Item
        action Take(actor: Actor, target: Item) { succeed; }
        case Take(target: Item) as BadArity { succeed; }
      `),
    ).toThrow(LanguageModelError);

    expect(() =>
      loadStoryProgram(`
        trait Actor
        trait Item
        action Take(actor: Actor, target: Item) { succeed; }
        case Take(actor: Actor, target: Item) as DuplicateCase { succeed; }
        case Take(actor: Actor, target: Item) as DuplicateCase { succeed; }
      `),
    ).toThrow(LanguageModelError);

    expect(() =>
      loadStoryProgram(`
        trait Actor
        trait Item
        action Take(actor: Actor, target: Item) { succeed; }
        replace case MissingCase { succeed; }
      `),
    ).toThrow(LanguageModelError);

    expect(() =>
      loadStoryProgram(`
        trait Actor
        trait Item
        action Take(actor: Actor, target: Item) { succeed; }
        undef case MissingCase
      `),
    ).toThrow(LanguageModelError);
  });
});

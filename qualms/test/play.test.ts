/**
 * Runtime action execution. Each test loads a small DSL definition into a
 * fresh GameDefinition + WorldState, then plays an action.
 */

import { describe, expect, it } from "vitest";
import { GameDefinition, dsl, instantiate, play } from "../src/index.js";

const { loadDslText } = dsl;
const { playAction, PlayError } = play;

function buildWorld(text: string): { def: GameDefinition; state: ReturnType<typeof instantiate> } {
  const def = new GameDefinition();
  loadDslText(def, text, { module: "prelude" });
  return { def, state: instantiate(def) };
}

describe("play.playAction: parameter binding and arg validation", () => {
  it("rejects unknown action", () => {
    const { def, state } = buildWorld("def trait Empty {}");
    expect(() => playAction(def, state, "Nope", {})).toThrowError(/unknown action/);
  });

  it("rejects missing required arg", () => {
    const { def, state } = buildWorld(
      "def action Greet(actor) { effects: [ emit { msg: actor } ] };",
    );
    expect(() => playAction(def, state, "Greet", {})).toThrowError(/missing argument/);
  });

  it("accepts arg with default", () => {
    const { def, state } = buildWorld(
      'def action Greet(name = "world") { effects: [ emit { msg: name } ] };',
    );
    const r = playAction(def, state, "Greet", {});
    expect(r.events).toEqual([{ msg: "world" }]);
  });

  it("rejects unknown arg key", () => {
    const { def, state } = buildWorld(
      "def action Greet(actor) { effects: [ emit { msg: actor } ] };",
    );
    expect(() =>
      playAction(def, state, "Greet", { actor: "a", bogus: "x" }),
    ).toThrowError(/unknown argument/);
  });
});

describe("play.playAction: requires evaluation", () => {
  it("trivial requires (literal true) succeeds", () => {
    const { def, state } = buildWorld(
      'def action Always(actor) { requires: true; effects: [ emit { msg: "ok" } ] };',
    );
    const r = playAction(def, state, "Always", { actor: "p" });
    expect(r.effectsApplied).toBe(1);
  });

  it("requires references parameter and reads runtime state", () => {
    const { def, state } = buildWorld(`
      def trait Actor {};
      def relation Awake(actor: Actor) {};
      def action Yell(actor: Actor) {
        requires: Awake(actor);
        effects: [ emit { msg: "ROAR" } ];
      };
    `);
    // Without the prerequisite asserted, requires fails.
    expect(() => playAction(def, state, "Yell", { actor: "lion" })).toThrowError(
      /requires.*not satisfied/,
    );
    // After asserting, it succeeds.
    state.assertRelation("Awake", ["lion"], "runtime");
    const r = playAction(def, state, "Yell", { actor: "lion" });
    expect(r.events[0]).toEqual({ msg: "ROAR" });
  });
});

describe("play.playAction: effect application", () => {
  it("`assert` writes to the live state", () => {
    const { def, state } = buildWorld(`
      def trait Actor {};
      def relation HasFlag(actor: Actor) {};
      def action Raise(actor: Actor) {
        effects: [ assert HasFlag(actor) ];
      };
    `);
    playAction(def, state, "Raise", { actor: "p" });
    expect(state.test("HasFlag", ["p"])).toBe(true);
  });

  it("`retract` removes a stored tuple", () => {
    const { def, state } = buildWorld(`
      def trait Actor {};
      def relation HasFlag(actor: Actor) {};
      def action Lower(actor: Actor) {
        effects: [ retract HasFlag(actor) ];
      };
    `);
    state.assertRelation("HasFlag", ["p"], "runtime");
    playAction(def, state, "Lower", { actor: "p" });
    expect(state.test("HasFlag", ["p"])).toBe(false);
  });

  it("`:=` writes a field on the named entity", () => {
    const { def, state } = buildWorld(`
      def trait Combatant { hp: int = 10; };
      def kind Fighter: Combatant;
      def entity bob: Fighter;
      def action Wound(target: Combatant, amount: int) {
        effects: [ target.hp := amount ];
      };
    `);
    playAction(def, state, "Wound", { target: "bob", amount: 3 });
    expect(state.entity("bob").traits["Combatant"]?.fields["hp"]).toBe(3);
  });

  it("`+=` adds to a set field; `-=` removes", () => {
    const { def, state } = buildWorld(`
      def trait Bag { contents: set<str> = {}; };
      def kind Sack: Bag;
      def entity sack: Sack;
      def action Stash(b: Bag, item: str) {
        effects: [ b.contents += item ];
      };
      def action Unstash(b: Bag, item: str) {
        effects: [ b.contents -= item ];
      };
    `);
    playAction(def, state, "Stash", { b: "sack", item: "rock" });
    playAction(def, state, "Stash", { b: "sack", item: "gem" });
    let contents = state.entity("sack").traits["Bag"]?.fields["contents"] as Set<unknown>;
    expect(contents.has("rock")).toBe(true);
    expect(contents.has("gem")).toBe(true);

    playAction(def, state, "Unstash", { b: "sack", item: "rock" });
    contents = state.entity("sack").traits["Bag"]?.fields["contents"] as Set<unknown>;
    expect(contents.has("rock")).toBe(false);
    expect(contents.has("gem")).toBe(true);
  });

  it("`emit` collects event payloads", () => {
    const { def, state } = buildWorld(`
      def action Speak(speaker: str, line: str) {
        effects: [ emit { speaker: speaker, text: line } ];
      };
    `);
    const r = playAction(def, state, "Speak", { speaker: "bob", line: "hi" });
    expect(r.events).toEqual([{ speaker: "bob", text: "hi" }]);
  });

  it("`assert R(...)` on a derived relation runs R's set: clause", () => {
    const { def, state } = buildWorld(`
      def trait Tagged { tag: str = ""; };
      def kind T: Tagged;
      def entity x: T;
      def relation Marked(e: Tagged, label: str) {
        get: e.tag = label;
        set: [ e.tag := label ];
      };
      def action Mark(e: Tagged, label: str) {
        effects: [ assert Marked(e, label) ];
      };
    `);
    playAction(def, state, "Mark", { e: "x", label: "ready" });
    expect(state.entity("x").traits["Tagged"]?.fields["tag"]).toBe("ready");
  });

  it("`assert R(...)` on a derived relation with no set: clause errors", () => {
    const { def, state } = buildWorld(`
      def trait T {};
      def relation Always(x: T) { get: true };
      def action Force(x: T) { effects: [ assert Always(x) ] };
    `);
    expect(() => playAction(def, state, "Force", { x: "p" })).toThrowError(
      /no set: clause/,
    );
  });

  it("emit can read a target's field at evaluation time", () => {
    const { def, state } = buildWorld(`
      def trait Presentable { name: str = ""; };
      def kind Thing: Presentable;
      def entity rock: Thing { Presentable.name = "Rock" };
      def action Name(target: Presentable) {
        effects: [ emit { text: target.name } ];
      };
    `);
    const r = playAction(def, state, "Name", { target: "rock" });
    expect(r.events).toEqual([{ text: "Rock" }]);
  });

  it("multi-effect action applies in order", () => {
    const { def, state } = buildWorld(`
      def trait Actor {};
      def relation Done(actor: Actor) {};
      def action Finish(actor: Actor) {
        effects: [ assert Done(actor); emit { msg: "fin" } ];
      };
    `);
    const r = playAction(def, state, "Finish", { actor: "p" });
    expect(r.effectsApplied).toBe(2);
    expect(r.events).toEqual([{ msg: "fin" }]);
    expect(state.test("Done", ["p"])).toBe(true);
  });
});

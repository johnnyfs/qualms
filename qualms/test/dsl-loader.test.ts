/**
 * Tests for the `.qualms` file format loader. Multi-statement DSL text →
 * applied to a fresh `GameDefinition` at the file's module attribution.
 */

import { describe, expect, it } from "vitest";
import { GameDefinition, dsl } from "../src/index.js";

const { loadDslText, DslLoadError } = dsl;

describe("dsl loader: file load to GameDefinition", () => {
  it("loads a trait definition", () => {
    const def = new GameDefinition();
    loadDslText(
      def,
      'def trait Presentable { name: str = ""; description: str = "" };',
      { module: "prelude" },
    );
    expect(def.hasTrait("Presentable")).toBe(true);
    const t = def.trait("Presentable");
    expect(t.module).toBe("prelude");
    expect(t.fields.map((f) => f.id)).toEqual(["name", "description"]);
  });

  it("loads multiple statements separated by `;`", () => {
    const def = new GameDefinition();
    loadDslText(
      def,
      `
        def trait Presentable { name: str = "" };
        def trait Container {};
        def kind Thing: Presentable;
      `,
      { module: "prelude" },
    );
    expect(def.hasTrait("Presentable")).toBe(true);
    expect(def.hasTrait("Container")).toBe(true);
    expect(def.hasKind("Thing")).toBe(true);
    expect(def.kind("Thing").traits.map((t) => t.id)).toEqual(["Presentable"]);
  });

  it("loads nested def relation/action inside a trait", () => {
    const def = new GameDefinition();
    loadDslText(
      def,
      `
        def trait Location {
          def relation Path(source: ref<Location>, target: ref<Location>) {};
        };
      `,
      { module: "prelude" },
    );
    expect(def.hasTrait("Location")).toBe(true);
    expect(def.hasRelation("Path")).toBe(true);
    expect(def.relation("Path").module).toBe("prelude");
  });

  it("loads a derived relation with `get` body", () => {
    const def = new GameDefinition();
    loadDslText(
      def,
      `
        def trait Relocatable {
          location: ref<Location>? = null;
          def relation At(subject, target) {
            get: subject.Relocatable.location = target;
          };
        };
      `,
      { module: "prelude" },
    );
    const at = def.relation("At");
    expect(at.get).toBeDefined();
  });

  it("loads a kind with field overrides", () => {
    const def = new GameDefinition();
    loadDslText(
      def,
      `
        def trait Presentable { name: str = "" };
        def trait Combatant { hp: int = 10 };
        def kind Foe: Combatant, Presentable {
          Presentable.name = "Foe";
        };
      `,
      { module: "prelude" },
    );
    expect(def.kind("Foe").traits.map((t) => t.id)).toEqual(["Combatant", "Presentable"]);
  });

  it("loads at game module attribution", () => {
    const def = new GameDefinition();
    // Prelude trait the game references.
    loadDslText(def, 'def trait Presentable { name: str = "" };', { module: "prelude" });
    loadDslText(
      def,
      `
        def trait Combatant { hp: int = 10 };
        def kind Foe: Combatant, Presentable;
        def entity grunt: Foe { Combatant.hp = 5; Presentable.name = "Grunt" };
      `,
      { module: "game" },
    );
    expect(def.trait("Combatant").module).toBe("game");
    expect(def.kind("Foe").module).toBe("game");
    expect(def.initialEntity("grunt").module).toBe("game");
  });

  it("rejects non-def statements at file scope", () => {
    const def = new GameDefinition();
    expect(() =>
      loadDslText(def, 'query { k | k : Kind };', { module: "game" }),
    ).toThrowError(DslLoadError);
    expect(() =>
      loadDslText(def, 'undef trait Foo;', { module: "game" }),
    ).toThrowError(DslLoadError);
  });

  it("rejects parse errors with source path in message", () => {
    const def = new GameDefinition();
    expect(() =>
      loadDslText(def, "def trait", { module: "prelude", source: "/test/x.qualms" }),
    ).toThrowError(/x\.qualms/);
  });

  it("# line comments are skipped", () => {
    const def = new GameDefinition();
    loadDslText(
      def,
      `
        # The Presentable trait — universal display fields.
        def trait Presentable {
          name: str = "";   # display name
        };
      `,
      { module: "prelude" },
    );
    expect(def.hasTrait("Presentable")).toBe(true);
    expect(def.trait("Presentable").fields.map((f) => f.id)).toEqual(["name"]);
  });

  it("body-bearing defs do not require trailing `;`", () => {
    const def = new GameDefinition();
    loadDslText(
      def,
      `
        def trait A {}
        def trait B { name: str = "" }
        def trait C {}
      `,
      { module: "prelude" },
    );
    expect(def.hasTrait("A")).toBe(true);
    expect(def.hasTrait("B")).toBe(true);
    expect(def.hasTrait("C")).toBe(true);
  });

  it("body-less defs still require `;`", () => {
    const def = new GameDefinition();
    loadDslText(def, "def trait Presentable {}", { module: "prelude" });
    // `def kind X: T1, T2;` and `undef trait Foo;` — these need `;` since no `}`.
    loadDslText(def, "def kind Thing: Presentable;", { module: "prelude" });
    expect(def.hasKind("Thing")).toBe(true);
  });

  it("trailing `;` after a body-bearing def is still legal (back-compat)", () => {
    const def = new GameDefinition();
    loadDslText(def, "def trait Foo {}; def trait Bar {};", { module: "prelude" });
    expect(def.hasTrait("Foo")).toBe(true);
    expect(def.hasTrait("Bar")).toBe(true);
  });
});

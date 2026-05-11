import { describe, expect, it } from "vitest";
import { classifyInput } from "../src/dispatch.js";

describe("classifyInput", () => {
  it("classifies a bare relation atom as a call", () => {
    const result = classifyInput("Go(Player, Corridor)");
    expect(result.kind).toBe("call");
    if (result.kind !== "call") throw new Error("expected call");
    expect(result.atom.relation).toBe("Go");
  });

  it("classifies a set block as a program", () => {
    const result = classifyInput("set { At(Player, Cell); }");
    expect(result.kind).toBe("program");
  });

  it("classifies an entity definition as a program", () => {
    const result = classifyInput("entity Robot { Actor }");
    expect(result.kind).toBe("program");
  });

  it("returns an error for malformed input", () => {
    const result = classifyInput("not even close (((");
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error");
    expect(result.message.length).toBeGreaterThan(0);
  });
});

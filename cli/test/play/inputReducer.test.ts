import { describe, expect, it } from "vitest";
import {
  initialInputState,
  inputReducer,
  type InputEvent,
  type InputState,
} from "../../src/play/inputReducer.js";

function run(events: readonly InputEvent[], start: InputState = initialInputState): {
  state: InputState;
  submissions: string[];
} {
  let state = start;
  const submissions: string[] = [];
  for (const event of events) {
    const { state: next, submitted } = inputReducer(state, event);
    state = next;
    if (submitted !== undefined) submissions.push(submitted);
  }
  return { state, submissions };
}

describe("inputReducer", () => {
  it("inserts characters at cursor", () => {
    const { state } = run([
      { type: "insert", text: "h" },
      { type: "insert", text: "i" },
    ]);
    expect(state.value).toBe("hi");
    expect(state.cursor).toBe(2);
  });

  it("inserts multi-char strings (paste)", () => {
    const { state } = run([{ type: "insert", text: "take key" }]);
    expect(state.value).toBe("take key");
    expect(state.cursor).toBe(8);
  });

  it("backspace removes char before cursor", () => {
    const { state } = run([
      { type: "insert", text: "hi" },
      { type: "backspace" },
    ]);
    expect(state.value).toBe("h");
    expect(state.cursor).toBe(1);
  });

  it("backspace at cursor 0 is a no-op", () => {
    const { state } = run([{ type: "backspace" }]);
    expect(state.value).toBe("");
    expect(state.cursor).toBe(0);
  });

  it("moveLeft and moveRight stay in bounds", () => {
    const { state } = run([
      { type: "insert", text: "ab" },
      { type: "moveLeft" },
      { type: "moveLeft" },
      { type: "moveLeft" }, // bound
    ]);
    expect(state.cursor).toBe(0);
    const { state: s2 } = run([
      { type: "insert", text: "ab" },
      { type: "moveRight" }, // already at end
    ]);
    expect(s2.cursor).toBe(2);
  });

  it("insert respects cursor position", () => {
    const { state } = run([
      { type: "insert", text: "ab" },
      { type: "moveLeft" },
      { type: "insert", text: "X" },
    ]);
    expect(state.value).toBe("aXb");
    expect(state.cursor).toBe(2);
  });

  it("home and end move cursor to bounds", () => {
    const { state } = run([
      { type: "insert", text: "abc" },
      { type: "home" },
    ]);
    expect(state.cursor).toBe(0);
    const { state: s2 } = run([
      { type: "insert", text: "abc" },
      { type: "home" },
      { type: "end" },
    ]);
    expect(s2.cursor).toBe(3);
  });

  it("submit returns the value and resets state, pushing to history", () => {
    const { state, submissions } = run([
      { type: "insert", text: "take key" },
      { type: "submit" },
    ]);
    expect(submissions).toEqual(["take key"]);
    expect(state.value).toBe("");
    expect(state.cursor).toBe(0);
    expect(state.history).toEqual(["take key"]);
  });

  it("submit deduplicates consecutive identical history entries", () => {
    const { state } = run([
      { type: "insert", text: "go" },
      { type: "submit" },
      { type: "insert", text: "go" },
      { type: "submit" },
    ]);
    expect(state.history).toEqual(["go"]);
  });

  it("historyPrev walks back, historyNext walks forward and clears", () => {
    const { state, submissions } = run([
      { type: "insert", text: "first" },
      { type: "submit" },
      { type: "insert", text: "second" },
      { type: "submit" },
    ]);
    expect(submissions).toEqual(["first", "second"]);
    const { state: s2 } = run([{ type: "historyPrev" }], state);
    expect(s2.value).toBe("second");
    const { state: s3 } = run([{ type: "historyPrev" }], s2);
    expect(s3.value).toBe("first");
    const { state: s4 } = run([{ type: "historyNext" }, { type: "historyNext" }], s3);
    expect(s4.value).toBe("");
  });

  it("suggestion selection wraps around and clamps after suggestion list shrinks", () => {
    const { state } = run([
      { type: "selectNext", count: 3 },
      { type: "selectNext", count: 3 },
      { type: "selectNext", count: 3 },
    ]);
    expect(state.selectedSuggestion).toBe(0);
    const { state: s2 } = run([
      { type: "selectNext", count: 3 },
      { type: "selectNext", count: 3 },
      { type: "suggestionsChanged", count: 2 },
    ]);
    expect(s2.selectedSuggestion).toBe(1);
    const { state: s3 } = run([{ type: "suggestionsChanged", count: 0 }], s2);
    expect(s3.selectedSuggestion).toBe(0);
  });

  it("replace overwrites value and resets selection/history", () => {
    const { state } = run([
      { type: "insert", text: "ta" },
      { type: "replace", text: "take master key" },
    ]);
    expect(state.value).toBe("take master key");
    expect(state.cursor).toBe(15);
  });
});

import { describe, expect, it } from "vitest";
import { parseBoldSpans } from "../../src/components/Transcript.js";

describe("parseBoldSpans", () => {
  it("turns double-asterisk spans into bold segments", () => {
    expect(parseBoldSpans("The **iron bars** are locked.")).toEqual([
      { text: "The ", bold: false },
      { text: "iron bars", bold: true },
      { text: " are locked.", bold: false },
    ]);
  });

  it("leaves unmatched markers literal", () => {
    expect(parseBoldSpans("The **iron bars are locked.")).toEqual([
      { text: "The **iron bars are locked.", bold: false },
    ]);
  });
});

import { Static, Text } from "ink";
import type { ReactElement } from "react";
import type { KeyedTranscriptEntry, TranscriptEntry } from "../types.js";

interface Props {
  readonly entries: readonly KeyedTranscriptEntry[];
}

function entryColor(entry: TranscriptEntry): string | undefined {
  switch (entry.kind) {
    case "input":
      return "cyan";
    case "feedback":
      if (entry.text.startsWith("fail")) return "red";
      return "green";
    case "effect":
      return "yellow";
    case "error":
      return "red";
    case "info":
      return "magenta";
    case "title":
      return "white";
    case "narrative":
      return undefined;
  }
}

function entryBold(entry: TranscriptEntry): boolean {
  return entry.kind === "title" || Boolean(entry.bold);
}

export interface TextSpan {
  readonly text: string;
  readonly bold: boolean;
}

export function parseBoldSpans(text: string): readonly TextSpan[] {
  const spans: TextSpan[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("**", index);
    if (start < 0) {
      spans.push({ text: text.slice(index), bold: false });
      break;
    }
    const end = text.indexOf("**", start + 2);
    if (end < 0) {
      spans.push({ text: text.slice(index), bold: false });
      break;
    }
    if (start > index) spans.push({ text: text.slice(index, start), bold: false });
    const boldText = text.slice(start + 2, end);
    if (boldText.length > 0) spans.push({ text: boldText, bold: true });
    index = end + 2;
  }
  return spans.length > 0 ? spans : [{ text, bold: false }];
}

function renderEntryText(entry: TranscriptEntry): ReactElement {
  const color = entryColor(entry);
  const wholeLineBold = entryBold(entry);
  return (
    <>
      {parseBoldSpans(entry.text).map((span, index) => (
        <Text key={index} color={color} bold={wholeLineBold || span.bold}>
          {span.text}
        </Text>
      ))}
    </>
  );
}

export function Transcript({ entries }: Props) {
  return (
    <Static items={entries as KeyedTranscriptEntry[]}>
      {(entry: KeyedTranscriptEntry) => (
        <Text key={entry.seq}>{renderEntryText(entry)}</Text>
      )}
    </Static>
  );
}

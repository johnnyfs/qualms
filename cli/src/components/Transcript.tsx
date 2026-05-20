import { Static, Text } from "ink";
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

export function Transcript({ entries }: Props) {
  return (
    <Static items={entries as KeyedTranscriptEntry[]}>
      {(entry: KeyedTranscriptEntry) => (
        <Text key={entry.seq} color={entryColor(entry)} bold={entryBold(entry)}>
          {entry.text}
        </Text>
      )}
    </Static>
  );
}

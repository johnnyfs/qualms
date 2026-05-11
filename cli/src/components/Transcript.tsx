import { Static, Text } from "ink";
import type { TranscriptEntry } from "../types.js";

interface Props {
  readonly entries: readonly TranscriptEntry[];
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
  }
}

export function Transcript({ entries }: Props) {
  const indexed = entries.map((entry, index) => ({ ...entry, index }));
  return (
    <Static items={indexed}>
      {(entry) => (
        <Text key={entry.index} color={entryColor(entry)}>
          {entry.text}
        </Text>
      )}
    </Static>
  );
}

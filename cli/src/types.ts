export type TranscriptEntryKind =
  | "input"
  | "feedback"
  | "effect"
  | "error"
  | "info"
  | "narrative"
  | "title";

export interface TranscriptEntry {
  readonly kind: TranscriptEntryKind;
  readonly text: string;
}

export interface KeyedTranscriptEntry extends TranscriptEntry {
  readonly seq: number;
}

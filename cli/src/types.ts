export type TranscriptEntryKind = "input" | "feedback" | "effect" | "error" | "info";

export interface TranscriptEntry {
  readonly kind: TranscriptEntryKind;
  readonly text: string;
}

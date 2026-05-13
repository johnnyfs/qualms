import type { language } from "@quealm/qualms";
import type { TranscriptEntry } from "../types.js";
import type { PlayConfig } from "./config.js";
import type { NameIndex } from "./naming.js";
import type { VerbTable } from "./verbs.js";

export interface ViewContext {
  readonly model: language.StoryModel;
  readonly config: PlayConfig;
  readonly names: NameIndex;
  readonly verbs: VerbTable;
  readonly lastAtom?: language.RelationAtom;
  readonly lastResult?: language.LanguagePlayResult;
  readonly lastQueryResult?: language.LanguageQueryResult;
  readonly lastError?: string;
}

export interface View {
  readonly id: string;
  renderTurn(ctx: ViewContext): readonly TranscriptEntry[];
}

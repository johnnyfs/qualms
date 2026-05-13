import { language } from "@quealm/qualms";
import type { TranscriptEntry } from "../types.js";
import type { PlayConfig } from "./config.js";
import { buildNameIndex, type NameIndex } from "./naming.js";
import { parsePlayInput, type ParseError } from "./parse.js";
import { buildVerbTable, type VerbTable } from "./verbs.js";
import { infocomView } from "./infocomView.js";
import type { View } from "./view.js";

const { playLanguageCall, playLanguageQuery } = language;

export interface PlaySession {
  readonly model: language.StoryModel;
  readonly config: PlayConfig;
  readonly names: NameIndex;
  readonly verbs: VerbTable;
  readonly view: View;
}

export function createPlaySession(
  model: language.StoryModel,
  config: PlayConfig,
  view: View = infocomView,
): PlaySession {
  return {
    model,
    config,
    names: buildNameIndex(model, config),
    verbs: buildVerbTable(model, config),
    view,
  };
}

export function renderInitialView(session: PlaySession): readonly TranscriptEntry[] {
  return session.view.renderTurn({
    model: session.model,
    config: session.config,
    names: session.names,
    verbs: session.verbs,
  });
}

export function handlePlayInput(
  session: PlaySession,
  input: string,
): readonly TranscriptEntry[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const parsed = parsePlayInput(trimmed, {
    verbs: session.verbs,
    names: session.names,
    config: session.config,
  });

  if (parsed.kind !== "ok") {
    return session.view.renderTurn({
      model: session.model,
      config: session.config,
      names: session.names,
      verbs: session.verbs,
      lastError: parseErrorMessage(parsed, session.names),
    });
  }

  if (parsed.verb.kind === "query") {
    const queryResult = playLanguageQuery(session.model, parsed.atom);
    return session.view.renderTurn({
      model: session.model,
      config: session.config,
      names: session.names,
      verbs: session.verbs,
      lastAtom: parsed.atom,
      lastQueryResult: queryResult,
    });
  }

  const result = playLanguageCall(session.model, parsed.atom);
  return session.view.renderTurn({
    model: session.model,
    config: session.config,
    names: session.names,
    verbs: session.verbs,
    lastAtom: parsed.atom,
    lastResult: result,
  });
}

function parseErrorMessage(err: ParseError, names: NameIndex): string {
  switch (err.kind) {
    case "empty":
      return "Say something.";
    case "unknown_verb":
      return `I don't know how to "${err.text}".`;
    case "missing_preposition":
      return `Try "${err.preposition}" — I didn't see a "${err.preposition}" in there.`;
    case "missing_noun":
      return err.parameterName
        ? `What ${err.parameterName}?`
        : "What did you mean?";
    case "unknown_noun":
      return `I don't see any "${err.phrase}" here.`;
    case "ambiguous_noun": {
      const list = err.candidates.map((id) => `the ${names.displayName(id)}`).join(" or ");
      return `Do you mean ${list}?`;
    }
    case "trailing_text":
      return `I didn't understand "${err.text}".`;
  }
}

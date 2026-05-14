import { language } from "@quealm/qualms";
import type { TranscriptEntry } from "../types.js";
import type { PlayConfig } from "./config.js";
import { buildNameIndex, type NameIndex } from "./naming.js";
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

export interface MenuSubmitResult {
  readonly entries: readonly TranscriptEntry[];
  readonly atom: language.RelationAtom;
  readonly result?: language.LanguagePlayResult;
  readonly queryResult?: language.LanguageQueryResult;
}

/**
 * Runs a menu-built atom against the model and renders the result via the session view.
 * Dispatches to playLanguageCall (action) or playLanguageQuery (query) based on the
 * relation's kind in model. Unknown relations return a parser-free "unknown" message.
 */
export function handleMenuSubmit(
  session: PlaySession,
  atom: language.RelationAtom,
): MenuSubmitResult {
  if (session.model.actions.has(atom.relation)) {
    const result = playLanguageCall(session.model, atom);
    const entries = session.view.renderTurn({
      model: session.model,
      config: session.config,
      names: session.names,
      verbs: session.verbs,
      lastAtom: atom,
      lastResult: result,
    });
    return { entries, atom, result };
  }
  if (session.model.queries.has(atom.relation)) {
    const queryResult = playLanguageQuery(session.model, atom);
    const entries = session.view.renderTurn({
      model: session.model,
      config: session.config,
      names: session.names,
      verbs: session.verbs,
      lastAtom: atom,
      lastQueryResult: queryResult,
    });
    return { entries, atom, queryResult };
  }
  return {
    entries: session.view.renderTurn({
      model: session.model,
      config: session.config,
      names: session.names,
      verbs: session.verbs,
      lastError: `unknown action or query '${atom.relation}'`,
    }),
    atom,
  };
}


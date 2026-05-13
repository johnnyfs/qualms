import { language } from "@quealm/qualms";
import type { PlayConfig } from "./config.js";

const { evalLanguageAtom } = language;

export function currentLocation(
  model: language.StoryModel,
  config: PlayConfig,
): string | undefined {
  const facts = model.listFacts(config.visibility.locationFact);
  for (const fact of facts) {
    const subject = fact.args[0];
    if (subject?.kind !== "id" || subject.id !== config.player) continue;
    const location = fact.args[1];
    if (location?.kind === "id") return location.id;
  }
  return undefined;
}

export interface VisibleEntities {
  readonly ids: readonly string[];
  readonly usedFallback: boolean;
}

export function visibleEntities(
  model: language.StoryModel,
  config: PlayConfig,
): VisibleEntities {
  const player = config.player;
  const predicateName = config.visibility.predicate;
  const candidates: string[] = [];
  for (const id of model.entities.keys()) {
    if (id === player) continue;
    candidates.push(id);
  }
  candidates.sort();

  if (model.predicates.has(predicateName)) {
    const ids: string[] = [];
    for (const id of candidates) {
      if (isVisibleByPredicate(model, predicateName, player, id)) ids.push(id);
    }
    return { ids, usedFallback: false };
  }

  const location = currentLocation(model, config);
  if (!location) return { ids: [], usedFallback: true };
  const facts = model.listFacts(config.visibility.locationFact);
  const ids: string[] = [];
  for (const fact of facts) {
    const subject = fact.args[0];
    const where = fact.args[1];
    if (subject?.kind !== "id" || where?.kind !== "id") continue;
    if (where.id !== location) continue;
    if (subject.id === player) continue;
    ids.push(subject.id);
  }
  ids.sort();
  return { ids, usedFallback: true };
}

function isVisibleByPredicate(
  model: language.StoryModel,
  predicate: string,
  actor: string,
  target: string,
): boolean {
  const atom: language.RelationAtom = {
    relation: predicate,
    args: [
      { kind: "identifier", id: actor },
      { kind: "identifier", id: target },
    ],
  };
  // evalLanguageAtom clones the model internally when invoking predicates,
  // so this is read-only with respect to the caller's model.
  const result = evalLanguageAtom(model.clone(), atom);
  return result.status === "passed";
}

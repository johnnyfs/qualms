import type {
  CallableStatement,
  EntityStatement,
  ExtendStatement,
  Program,
  RelationAtom,
  RelationStatement,
  RuleStatement,
  SetEffect,
  Term,
  TraitStatement,
} from "./ast.js";
import { parseProgram } from "./parser.js";

export type GroundTerm =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "relation"; readonly relation: string; readonly args: readonly GroundTerm[] };

export interface Fact {
  readonly relation: string;
  readonly args: readonly GroundTerm[];
}

export class LanguageModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanguageModelError";
  }
}

export class StoryModel {
  readonly traits = new Map<string, TraitStatement>();
  readonly relations = new Map<string, RelationStatement>();
  readonly predicates = new Map<string, CallableStatement>();
  readonly actions = new Map<string, CallableStatement>();
  readonly rules: RuleStatement[] = [];
  readonly entities = new Map<string, Set<string>>();
  private readonly facts = new Map<string, Fact>();

  clone(): StoryModel {
    const clone = new StoryModel();
    for (const [id, trait] of this.traits) clone.traits.set(id, trait);
    for (const [id, relation] of this.relations) clone.relations.set(id, relation);
    for (const [id, predicate] of this.predicates) clone.predicates.set(id, predicate);
    for (const [id, action] of this.actions) clone.actions.set(id, action);
    clone.rules.push(...this.rules);
    for (const [id, traits] of this.entities) clone.entities.set(id, new Set(traits));
    for (const [key, fact] of this.facts) clone.facts.set(key, fact);
    return clone;
  }

  apply(program: Program): void {
    for (const statement of program.statements) {
      switch (statement.kind) {
        case "trait":
          this.addUnique(this.traits, statement.id, statement, "trait");
          break;
        case "relation":
          this.addUnique(this.relations, statement.id, statement, "relation");
          break;
        case "predicate":
          this.addUnique(this.predicates, statement.id, statement, "predicate");
          break;
        case "action":
          this.addUnique(this.actions, statement.id, statement, "action");
          break;
        case "rule":
          this.rules.push(statement);
          break;
        case "entity":
          this.addEntity(statement);
          break;
        case "extend":
          this.extendEntity(statement);
          break;
        case "set":
          this.applySet(statement.effects);
          break;
      }
    }
  }

  hasFact(relation: string, args: readonly GroundTerm[]): boolean {
    return this.facts.has(factKey({ relation, args }));
  }

  listFacts(relation?: string): Fact[] {
    const out = [...this.facts.values()];
    return relation ? out.filter((fact) => fact.relation === relation) : out;
  }

  assertFact(fact: Fact): void {
    this.requireRelation(fact.relation);
    this.applyCardinality(fact);
    this.facts.set(factKey(fact), fact);
  }

  retractFact(fact: Fact): void {
    this.requireRelation(fact.relation);
    this.facts.delete(factKey(fact));
  }

  entityTraits(id: string): Set<string> {
    const traits = this.entities.get(id);
    if (!traits) throw new LanguageModelError(`unknown entity '${id}'`);
    return new Set(traits);
  }

  private addEntity(statement: EntityStatement): void {
    if (this.entities.has(statement.id)) {
      throw new LanguageModelError(`duplicate entity '${statement.id}'`);
    }
    const traits = new Set<string>();
    for (const traitId of statement.traits) {
      this.requireTrait(traitId);
      traits.add(traitId);
    }
    this.entities.set(statement.id, traits);
  }

  private extendEntity(statement: ExtendStatement): void {
    const traits = this.entities.get(statement.id);
    if (!traits) throw new LanguageModelError(`unknown entity '${statement.id}'`);
    for (const traitId of statement.traits) {
      this.requireTrait(traitId);
      traits.add(traitId);
    }
  }

  private applySet(effects: readonly SetEffect[]): void {
    for (const effect of effects) {
      const fact = factFromAtom(effect.atom);
      if (effect.polarity === "assert") this.assertFact(fact);
      else this.retractFact(fact);
    }
  }

  private addUnique<T>(map: Map<string, T>, id: string, value: T, kind: string): void {
    if (map.has(id)) throw new LanguageModelError(`duplicate ${kind} '${id}'`);
    map.set(id, value);
  }

  private requireTrait(id: string): void {
    if (!this.traits.has(id)) throw new LanguageModelError(`unknown trait '${id}'`);
  }

  private requireRelation(id: string): void {
    if (!this.relations.has(id)) throw new LanguageModelError(`unknown relation '${id}'`);
  }

  private applyCardinality(fact: Fact): void {
    const relation = this.relations.get(fact.relation);
    if (!relation) return;
    const oneIndexes = relation.parameters
      .map((parameter, index) => (parameter.cardinality === "one" ? index : -1))
      .filter((index) => index >= 0);
    if (oneIndexes.length === 0) return;

    for (const existing of this.listFacts(fact.relation)) {
      let sameKey = true;
      for (let i = 0; i < relation.parameters.length; i++) {
        if (oneIndexes.includes(i)) continue;
        if (termKey(existing.args[i]) !== termKey(fact.args[i])) {
          sameKey = false;
          break;
        }
      }
      if (sameKey) this.facts.delete(factKey(existing));
    }
  }
}

export function loadStoryProgram(source: string | Program): StoryModel {
  const program = typeof source === "string" ? parseProgram(source) : source;
  const model = new StoryModel();
  model.apply(program);
  return model;
}

export function factFromAtom(atom: RelationAtom): Fact {
  return {
    relation: atom.relation,
    args: atom.args.map(groundTermFromTerm),
  };
}

export function groundTermFromTerm(term: Term): GroundTerm {
  switch (term.kind) {
    case "identifier":
      return { kind: "id", id: term.id };
    case "string":
      return { kind: "string", value: term.value };
    case "number":
      return { kind: "number", value: term.value };
    case "relationInstance":
      return {
        kind: "relation",
        relation: term.atom.relation,
        args: term.atom.args.map(groundTermFromTerm),
      };
    case "wildcard":
      throw new LanguageModelError("wildcards are not valid in ground facts");
  }
}

export function factKey(fact: Fact): string {
  return `${fact.relation}|${JSON.stringify(fact.args)}`;
}

export function termKey(term: GroundTerm | undefined): string {
  return JSON.stringify(term);
}

export function idTerm(id: string): GroundTerm {
  return { kind: "id", id };
}

export function relationTerm(relation: string, args: readonly GroundTerm[]): GroundTerm {
  return { kind: "relation", relation, args };
}

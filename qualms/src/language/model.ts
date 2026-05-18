import type {
  ActionCaseStatement,
  Block,
  BodyStatement,
  CallableStatement,
  EntityStatement,
  ExternPredicateStatement,
  ExtendStatement,
  Program,
  QueryStatement,
  RelationAtom,
  RelationParameter,
  RelationStatement,
  ReplaceActionCaseStatement,
  RuleStatement,
  SetEffect,
  Term,
  TraitStatement,
  TypeExpr,
  UndefCaseStatement,
  ValidationStatement,
} from "./ast.js";
import { parseProgram } from "./parser.js";
import { runLanguageValidations, type LanguageValidationFailure } from "./runtime.js";

export type GroundTerm =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "relation"; readonly relation: string; readonly args: readonly GroundTerm[] };

export interface Fact {
  readonly relation: string;
  readonly args: readonly GroundTerm[];
}

export interface Effect {
  readonly polarity: "assert" | "retract";
  readonly fact: Fact;
}

export interface StoredActionCaseStatement extends ActionCaseStatement {
  readonly id: string;
}

export class LanguageModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanguageModelError";
  }
}

export class LanguageValidationFailedError extends LanguageModelError {
  constructor(public readonly failures: readonly LanguageValidationFailure[]) {
    super(
      `validation failed: ${failures
        .map((failure) => `${failure.validation}#${failure.assertion}: ${failure.message}`)
        .join("; ")}`,
    );
    this.name = "LanguageValidationFailedError";
  }
}

export class StoryModel {
  readonly traits = new Map<string, TraitStatement>();
  readonly relations = new Map<string, RelationStatement>();
  readonly externalPredicates = new Map<string, ExternPredicateStatement>();
  readonly predicates = new Map<string, CallableStatement>();
  readonly actions = new Map<string, CallableStatement>();
  readonly actionCases: StoredActionCaseStatement[] = [];
  readonly queries = new Map<string, QueryStatement>();
  readonly rules: RuleStatement[] = [];
  readonly validations = new Map<string, ValidationStatement>();
  readonly entities = new Map<string, Set<string>>();
  private readonly facts = new Map<string, Fact>();
  private snapshot: StoryModel | null = null;

  get inTransaction(): boolean {
    return this.snapshot !== null;
  }

  clone(): StoryModel {
    const clone = new StoryModel();
    for (const [id, trait] of this.traits) clone.traits.set(id, trait);
    for (const [id, relation] of this.relations) clone.relations.set(id, relation);
    for (const [id, predicate] of this.externalPredicates) clone.externalPredicates.set(id, predicate);
    for (const [id, predicate] of this.predicates) clone.predicates.set(id, predicate);
    for (const [id, action] of this.actions) clone.actions.set(id, action);
    clone.actionCases.push(...this.actionCases);
    for (const [id, query] of this.queries) clone.queries.set(id, query);
    clone.rules.push(...this.rules);
    for (const [id, validation] of this.validations) clone.validations.set(id, validation);
    for (const [id, traits] of this.entities) clone.entities.set(id, new Set(traits));
    for (const [key, fact] of this.facts) clone.facts.set(key, fact);
    return clone;
  }

  apply(program: Program): Effect[] {
    const effects: Effect[] = [];
    const preCall = this.snapshot !== null ? this.clone() : null;
    try {
      for (const statement of program.statements) {
        switch (statement.kind) {
          case "trait":
            this.addUnique(this.traits, statement.id, statement, "trait");
            break;
          case "relation":
            this.validateRelation(statement);
            this.addUnique(this.relations, statement.id, statement, "relation");
            break;
          case "externPredicate":
            this.addExternPredicate(statement);
            break;
          case "predicate":
            this.addCallable(this.predicates, statement, "predicate");
            break;
          case "action":
            this.addCallable(this.actions, statement, "action");
            break;
          case "case":
            this.addActionCase(statement);
            break;
          case "replaceCase":
            this.replaceActionCase(statement);
            break;
          case "undefCase":
            this.undefActionCase(statement);
            break;
          case "query":
            this.addQuery(statement);
            break;
          case "rule":
            this.validateRule(statement);
            this.validateRulePurity(statement);
            this.rules.push(statement);
            break;
          case "entity":
            this.addEntity(statement);
            break;
          case "extend":
            this.extendEntity(statement);
            break;
          case "set":
            this.applySet(statement.effects, effects);
            break;
          case "validation":
            this.addValidation(statement);
            break;
          case "begin":
            this.beginTransaction();
            break;
          case "commit":
            this.commitTransaction();
            break;
          case "rollback":
            this.rollbackTransaction();
            break;
        }
      }
    } catch (e) {
      if (preCall) this.restoreFrom(preCall);
      throw e;
    }
    return effects;
  }

  private beginTransaction(): void {
    if (this.snapshot) throw new LanguageModelError("transaction already open");
    this.snapshot = this.clone();
  }

  private commitTransaction(): void {
    if (!this.snapshot) throw new LanguageModelError("no open transaction to commit");
    const result = runLanguageValidations(this);
    if (result.status === "failed") {
      throw new LanguageValidationFailedError(result.failures);
    }
    this.snapshot = null;
  }

  private rollbackTransaction(): void {
    if (!this.snapshot) throw new LanguageModelError("no open transaction to rollback");
    this.restoreFrom(this.snapshot);
    this.snapshot = null;
  }

  private restoreFrom(other: StoryModel): void {
    this.traits.clear();
    for (const [id, v] of other.traits) this.traits.set(id, v);
    this.relations.clear();
    for (const [id, v] of other.relations) this.relations.set(id, v);
    this.externalPredicates.clear();
    for (const [id, v] of other.externalPredicates) this.externalPredicates.set(id, v);
    this.predicates.clear();
    for (const [id, v] of other.predicates) this.predicates.set(id, v);
    this.actions.clear();
    for (const [id, v] of other.actions) this.actions.set(id, v);
    this.actionCases.length = 0;
    this.actionCases.push(...other.actionCases);
    this.queries.clear();
    for (const [id, v] of other.queries) this.queries.set(id, v);
    this.rules.length = 0;
    this.rules.push(...other.rules);
    this.validations.clear();
    for (const [id, v] of other.validations) this.validations.set(id, v);
    this.entities.clear();
    for (const [id, v] of other.entities) this.entities.set(id, new Set(v));
    this.facts.clear();
    for (const [k, v] of other.facts) this.facts.set(k, v);
  }

  hasFact(relation: string, args: readonly GroundTerm[]): boolean {
    return this.facts.has(factKey({ relation, args }));
  }

  listFacts(relation?: string): Fact[] {
    const out = [...this.facts.values()];
    return relation ? out.filter((fact) => fact.relation === relation) : out;
  }

  assertFact(fact: Fact): void {
    this.validateFact(fact);
    this.applyCardinality(fact);
    this.facts.set(factKey(fact), fact);
  }

  retractFact(fact: Fact): void {
    this.validateFact(fact);
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

  private applySet(setEffects: readonly SetEffect[], sink: Effect[]): void {
    for (const setEffect of setEffects) {
      const fact = factFromAtom(setEffect.atom);
      if (setEffect.polarity === "assert") this.assertFact(fact);
      else this.retractFact(fact);
      sink.push({ polarity: setEffect.polarity, fact });
    }
  }

  private addUnique<T>(map: Map<string, T>, id: string, value: T, kind: string): void {
    if (map.has(id)) throw new LanguageModelError(`duplicate ${kind} '${id}'`);
    map.set(id, value);
  }

  private addCallable(
    map: Map<string, CallableStatement>,
    statement: CallableStatement,
    kind: string,
  ): void {
    this.validateCallableTypes(statement);
    if (kind === "predicate" && blockContainsImpureStatement(statement.body)) {
      throw new LanguageModelError(`predicate '${statement.id}' cannot contain set or emit effects`);
    }
    if (statement.replace) {
      if (!map.has(statement.id)) {
        throw new LanguageModelError(
          `replace ${kind} '${statement.id}' has no prior definition`,
        );
      }
      map.set(statement.id, statement);
      return;
    }
    this.addUnique(map, statement.id, statement, kind);
  }

  private addExternPredicate(statement: ExternPredicateStatement): void {
    this.validateCallableTypes(statement);
    if (this.predicates.has(statement.id) || this.actions.has(statement.id) || this.queries.has(statement.id)) {
      throw new LanguageModelError(`duplicate callable '${statement.id}'`);
    }
    this.addUnique(this.externalPredicates, statement.id, statement, "external predicate");
  }

  private addQuery(statement: QueryStatement): void {
    this.validateCallableTypes(statement);
    if (
      this.predicates.has(statement.id) ||
      this.actions.has(statement.id) ||
      this.externalPredicates.has(statement.id)
    ) {
      throw new LanguageModelError(`duplicate callable '${statement.id}'`);
    }
    this.addUnique(this.queries, statement.id, statement, "query");
  }

  private addActionCase(statement: ActionCaseStatement): void {
    const id = statement.id ?? this.nextGeneratedCaseId(statement.target);
    if (this.caseIndex(id) >= 0) throw new LanguageModelError(`duplicate case '${id}'`);
    const stored: StoredActionCaseStatement = { ...statement, id };
    this.validateActionCase(stored);
    this.actionCases.push(stored);
  }

  private replaceActionCase(statement: ReplaceActionCaseStatement): void {
    const index = this.caseIndex(statement.id);
    if (index < 0) {
      throw new LanguageModelError(`replace case '${statement.id}' has no prior definition`);
    }
    const existing = this.actionCases[index]!;
    const replacement: StoredActionCaseStatement = {
      ...existing,
      ...(statement.parameters ? { parameters: statement.parameters } : {}),
      body: statement.body,
    };
    this.validateActionCase(replacement);
    this.actionCases[index] = replacement;
  }

  private undefActionCase(statement: UndefCaseStatement): void {
    const index = this.caseIndex(statement.id);
    if (index < 0) throw new LanguageModelError(`undef case '${statement.id}' has no prior definition`);
    this.actionCases.splice(index, 1);
  }

  private caseIndex(id: string): number {
    return this.actionCases.findIndex((actionCase) => actionCase.id === id);
  }

  private nextGeneratedCaseId(target: string): string {
    for (let index = 1; ; index++) {
      const id = `${target}_${String(index).padStart(4, "0")}`;
      if (this.caseIndex(id) < 0) return id;
    }
  }

  private validateRulePurity(statement: RuleStatement): void {
    if (!this.predicates.has(statement.target)) return;
    if (blockContainsImpureStatement(statement.body)) {
      throw new LanguageModelError(
        `rule for predicate '${statement.target}' cannot contain set or emit effects`,
      );
    }
  }

  private addValidation(statement: ValidationStatement): void {
    if (statement.replace) {
      if (!this.validations.has(statement.id)) {
        throw new LanguageModelError(
          `replace validation '${statement.id}' has no prior definition`,
        );
      }
    } else if (this.validations.has(statement.id)) {
      throw new LanguageModelError(`duplicate validation '${statement.id}'`);
    }
    for (const assertion of statement.assertions) {
      if (assertion.kind === "fact") {
        this.validateFact(factFromAtom(assertion.atom));
      } else if (assertion.kind === "play") {
        const action = this.actions.get(assertion.atom.relation);
        if (!action) throw new LanguageModelError(`unknown validation action '${assertion.atom.relation}'`);
        if (action.parameters.length !== assertion.atom.args.length) {
          throw new LanguageModelError(
            `validation action '${assertion.atom.relation}' expects ${action.parameters.length} args, got ${assertion.atom.args.length}`,
          );
        }
        for (const effect of assertion.expectedEffects ?? []) {
          this.validateFact(factFromAtom(effect.atom));
        }
      }
    }
    this.validations.set(statement.id, statement);
  }

  private validateRelation(statement: RelationStatement): void {
    const seenNames = new Set<string>();
    for (const parameter of statement.parameters) {
      if (parameter.name) {
        if (seenNames.has(parameter.name)) {
          throw new LanguageModelError(`relation '${statement.id}' has duplicate parameter name '${parameter.name}'`);
        }
        seenNames.add(parameter.name);
      }
      this.validateRelationParameter(parameter);
    }
    if (statement.unique) {
      for (const name of statement.unique) {
        if (!seenNames.has(name)) {
          throw new LanguageModelError(`relation '${statement.id}' unique references unknown parameter '${name}'`);
        }
      }
    }
  }

  private validateRelationParameter(parameter: RelationParameter): void {
    this.validateTypeExpr(parameter.type);
  }

  private validateCallableTypes(statement: { readonly parameters: readonly { readonly type?: TypeExpr }[] }): void {
    for (const parameter of statement.parameters) {
      if (parameter.type) this.validateTypeExpr(parameter.type);
    }
  }

  private validateRule(statement: RuleStatement): void {
    const targetAction = this.actions.get(statement.target);
    const targetPredicate = this.predicates.get(statement.target);
    const target = targetAction ?? targetPredicate;
    if (!target) throw new LanguageModelError(`unknown rule target '${statement.target}'`);
    if (statement.phase === "after" && targetPredicate) {
      throw new LanguageModelError(`after rule cannot target predicate '${statement.target}'`);
    }
    if (target.parameters.length !== statement.parameters.length) {
      throw new LanguageModelError(
        `rule for '${statement.target}' has arity ${statement.parameters.length}, expected ${target.parameters.length}`,
      );
    }
    for (const parameter of statement.parameters) {
      if (parameter.type) this.validateTypeExpr(parameter.type);
    }
  }

  private validateActionCase(statement: StoredActionCaseStatement): void {
    const target = this.actions.get(statement.target);
    if (!target) throw new LanguageModelError(`unknown case action '${statement.target}'`);
    if (target.parameters.length !== statement.parameters.length) {
      throw new LanguageModelError(
        `case for '${statement.target}' has arity ${statement.parameters.length}, expected ${target.parameters.length}`,
      );
    }
    for (const parameter of statement.parameters) {
      if (parameter.type) this.validateTypeExpr(parameter.type);
    }
  }

  private validateTypeExpr(type: TypeExpr): void {
    if (type.kind === "intersection") {
      for (const inner of type.types) this.validateTypeExpr(inner);
      return;
    }
    if (type.id === "Any") return;
    if (this.traits.has(type.id) || this.relations.has(type.id) || this.entities.has(type.id)) return;
    throw new LanguageModelError(`unknown type '${type.id}'`);
  }

  private validateFact(fact: Fact): void {
    const relation = this.relations.get(fact.relation);
    if (!relation) throw new LanguageModelError(`unknown relation '${fact.relation}'`);
    if (fact.args.length !== relation.parameters.length) {
      throw new LanguageModelError(
        `relation '${fact.relation}' expects ${relation.parameters.length} args, got ${fact.args.length}`,
      );
    }
    for (let i = 0; i < relation.parameters.length; i++) {
      const expected = relation.parameters[i]!.type;
      const actual = fact.args[i]!;
      if (!this.groundTermMatchesType(actual, expected)) {
        throw new LanguageModelError(
          `relation '${fact.relation}' arg ${i + 1} expected ${emitTypeExpr(expected)}, got ${emitGroundTermForError(actual)}`,
        );
      }
    }
  }

  private groundTermMatchesType(value: GroundTerm, type: TypeExpr): boolean {
    if (type.kind === "intersection") {
      return type.types.every((inner) => this.groundTermMatchesType(value, inner));
    }
    if (type.id === "Any") return this.groundTermIsValid(value);
    if (this.traits.has(type.id)) {
      return value.kind === "id" && this.entities.get(value.id)?.has(type.id) === true;
    }
    if (this.relations.has(type.id)) {
      if (value.kind !== "relation" || value.relation !== type.id) return false;
      this.validateFact({ relation: value.relation, args: value.args });
      return true;
    }
    return false;
  }

  private groundTermIsValid(value: GroundTerm): boolean {
    if (value.kind === "relation") {
      this.validateFact({ relation: value.relation, args: value.args });
    }
    return true;
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
    const legacyOneIndexes = relation.parameters
      .map((parameter, index) => (parameter.cardinality === "one" ? index : -1))
      .filter((index) => index >= 0);
    const uniqueIndexes = relation.unique
      ? relation.unique.map((name) => relation.parameters.findIndex((parameter) => parameter.name === name))
      : [];
    if (legacyOneIndexes.length === 0 && uniqueIndexes.length === 0) return;

    for (const existing of this.listFacts(fact.relation)) {
      if (legacyOneIndexes.length > 0 && sameProjection(existing, fact, invertIndexes(relation.parameters.length, legacyOneIndexes))) {
        this.facts.delete(factKey(existing));
        continue;
      }
      if (uniqueIndexes.length > 0 && sameProjection(existing, fact, uniqueIndexes)) {
        this.facts.delete(factKey(existing));
      }
    }
  }
}

function invertIndexes(length: number, indexes: readonly number[]): number[] {
  const skipped = new Set(indexes);
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    if (!skipped.has(i)) out.push(i);
  }
  return out;
}

function sameProjection(left: Fact, right: Fact, indexes: readonly number[]): boolean {
  return indexes.every((index) => termKey(left.args[index]) === termKey(right.args[index]));
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
    case "variable":
      throw new LanguageModelError("variables are not valid in ground facts");
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

function blockContainsImpureStatement(block: Block): boolean {
  return block.statements.some(statementContainsImpureStatement);
}

function statementContainsImpureStatement(statement: BodyStatement): boolean {
  if (statement.kind === "set" || statement.kind === "emit") return true;
  if (statement.kind === "when") return blockContainsImpureStatement(statement.body);
  return false;
}

function emitTypeExpr(type: TypeExpr): string {
  if (type.kind === "named") return type.id;
  return `(${type.types.map(emitTypeExpr).join(" & ")})`;
}

function emitGroundTermForError(term: GroundTerm): string {
  switch (term.kind) {
    case "id":
      return term.id;
    case "string":
      return JSON.stringify(term.value);
    case "number":
      return String(term.value);
    case "relation":
      return `${term.relation}(${term.args.map(emitGroundTermForError).join(", ")})`;
  }
}

import type {
  BinaryExpression,
  Block,
  BodyStatement,
  CallableStatement,
  EntityStatement,
  EqualityExpression,
  Expression,
  ExtendStatement,
  NotExpression,
  ParameterPattern,
  Program,
  RelationAtom,
  RelationExpression,
  RelationParameter,
  RelationStatement,
  RuleStatement,
  SetEffect,
  SetStatement,
  Term,
  TopLevelStatement,
  TraitStatement,
  TypeExpr,
  WhenStatement,
} from "./ast.js";

export function emitProgram(program: Program): string {
  return program.statements.map(emitTopLevelStatement).join("\n\n") + "\n";
}

export function emitTopLevelStatement(statement: TopLevelStatement): string {
  switch (statement.kind) {
    case "trait":
      return emitTrait(statement);
    case "relation":
      return emitRelation(statement);
    case "predicate":
    case "action":
      return emitCallable(statement);
    case "rule":
      return emitRule(statement);
    case "entity":
      return emitEntity(statement);
    case "extend":
      return emitExtend(statement);
    case "set":
      return emitSet(statement);
  }
}

function emitTrait(statement: TraitStatement): string {
  return `trait ${statement.id}`;
}

function emitRelation(statement: RelationStatement): string {
  return `relation ${statement.id}(${statement.parameters.map(emitRelationParameter).join(", ")})`;
}

function emitRelationParameter(parameter: RelationParameter): string {
  return `${parameter.cardinality ? `${parameter.cardinality} ` : ""}${emitTypeExpr(parameter.type)}`;
}

function emitCallable(statement: CallableStatement): string {
  return `${statement.kind} ${statement.id}(${statement.parameters.map(emitParameter).join(", ")}) ${emitBlock(statement.body)}`;
}

function emitRule(statement: RuleStatement): string {
  return `${statement.phase} ${statement.target}(${statement.parameters.map(emitParameter).join(", ")}) ${emitBlock(statement.body)}`;
}

function emitEntity(statement: EntityStatement): string {
  return `entity ${statement.id} { ${statement.traits.join(", ")} }`;
}

function emitExtend(statement: ExtendStatement): string {
  return `extend ${statement.id} { ${statement.traits.join(", ")} }`;
}

function emitParameter(parameter: ParameterPattern): string {
  const head = parameter.wildcard ? "_" : parameter.name ?? "_";
  const type = parameter.type ? `: ${emitTypeExpr(parameter.type)}` : "";
  const constraints =
    parameter.constraints.length > 0
      ? ` { ${parameter.constraints.map(emitExpression).join("; ")} }`
      : "";
  return `${head}${type}${constraints}`;
}

function emitBlock(block: Block): string {
  if (block.statements.length === 0) return "{}";
  return `{\n${block.statements.map((statement) => indent(emitBodyStatement(statement))).join("\n")}\n}`;
}

function emitBodyStatement(statement: BodyStatement): string {
  switch (statement.kind) {
    case "when":
      return emitWhen(statement);
    case "set":
      return emitSet(statement);
    case "pass":
      return "pass;";
    case "fail":
      return "fail;";
  }
}

function emitWhen(statement: WhenStatement): string {
  return `when (${emitExpression(statement.condition)}) ${emitBlock(statement.body)}`;
}

function emitSet(statement: SetStatement): string {
  if (statement.effects.length === 1) return `set ${emitSetEffect(statement.effects[0]!)}`;
  return `set {\n${statement.effects.map((effect) => indent(`${emitSetEffect(effect)};`)).join("\n")}\n}`;
}

function emitSetEffect(effect: SetEffect): string {
  return `${effect.polarity === "retract" ? "!" : ""}${emitRelationAtom(effect.atom)}`;
}

function emitExpression(expression: Expression): string {
  switch (expression.kind) {
    case "relation":
      return emitRelationExpression(expression);
    case "not":
      return emitNotExpression(expression);
    case "binary":
      return emitBinaryExpression(expression);
    case "equal":
      return emitEqualityExpression(expression);
  }
}

function emitRelationExpression(expression: RelationExpression): string {
  return emitRelationAtom(expression.atom);
}

function emitNotExpression(expression: NotExpression): string {
  return `!${emitExpression(expression.operand)}`;
}

function emitBinaryExpression(expression: BinaryExpression): string {
  return `${emitExpression(expression.left)} ${expression.op} ${emitExpression(expression.right)}`;
}

function emitEqualityExpression(expression: EqualityExpression): string {
  return `${emitTerm(expression.left)} == ${emitTerm(expression.right)}`;
}

function emitRelationAtom(atom: RelationAtom): string {
  return `${atom.relation}(${atom.args.map(emitTerm).join(", ")})`;
}

function emitTerm(term: Term): string {
  switch (term.kind) {
    case "identifier":
      return term.id;
    case "wildcard":
      return "_";
    case "string":
      return JSON.stringify(term.value);
    case "number":
      return String(term.value);
    case "relationInstance":
      return emitRelationAtom(term.atom);
  }
}

function emitTypeExpr(type: TypeExpr): string {
  if (type.kind === "named") return type.id;
  return `(${type.types.map(emitTypeExpr).join(" & ")})`;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}


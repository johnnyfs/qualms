export interface Program {
  readonly statements: readonly TopLevelStatement[];
}

export type TopLevelStatement =
  | TraitStatement
  | RelationStatement
  | CallableStatement
  | RuleStatement
  | EntityStatement
  | ExtendStatement
  | SetStatement;

export interface TraitStatement {
  readonly kind: "trait";
  readonly id: string;
}

export interface RelationStatement {
  readonly kind: "relation";
  readonly id: string;
  readonly parameters: readonly RelationParameter[];
}

export interface RelationParameter {
  readonly type: TypeExpr;
  readonly cardinality?: "one";
}

export interface CallableStatement {
  readonly kind: "action" | "predicate";
  readonly id: string;
  readonly parameters: readonly ParameterPattern[];
  readonly body: Block;
}

export interface RuleStatement {
  readonly kind: "rule";
  readonly phase: "before" | "after";
  readonly target: string;
  readonly parameters: readonly ParameterPattern[];
  readonly body: Block;
}

export interface EntityStatement {
  readonly kind: "entity";
  readonly id: string;
  readonly traits: readonly string[];
}

export interface ExtendStatement {
  readonly kind: "extend";
  readonly id: string;
  readonly traits: readonly string[];
}

export interface SetStatement {
  readonly kind: "set";
  readonly effects: readonly SetEffect[];
}

export interface Block {
  readonly statements: readonly BodyStatement[];
}

export type BodyStatement = WhenStatement | SetStatement | PassStatement | FailStatement;

export interface WhenStatement {
  readonly kind: "when";
  readonly condition: Expression;
  readonly body: Block;
}

export interface PassStatement {
  readonly kind: "pass";
}

export interface FailStatement {
  readonly kind: "fail";
}

export interface SetEffect {
  readonly polarity: "assert" | "retract";
  readonly atom: RelationAtom;
}

export interface ParameterPattern {
  readonly name?: string;
  readonly wildcard: boolean;
  readonly type?: TypeExpr;
  readonly constraints: readonly Expression[];
}

export type TypeExpr =
  | { readonly kind: "named"; readonly id: string }
  | { readonly kind: "intersection"; readonly types: readonly TypeExpr[] };

export type Expression =
  | RelationExpression
  | NotExpression
  | BinaryExpression
  | EqualityExpression;

export interface RelationExpression {
  readonly kind: "relation";
  readonly atom: RelationAtom;
}

export interface NotExpression {
  readonly kind: "not";
  readonly operand: Expression;
}

export interface BinaryExpression {
  readonly kind: "binary";
  readonly op: "&" | "|";
  readonly left: Expression;
  readonly right: Expression;
}

export interface EqualityExpression {
  readonly kind: "equal";
  readonly left: Term;
  readonly right: Term;
}

export interface RelationAtom {
  readonly relation: string;
  readonly args: readonly Term[];
}

export type Term =
  | { readonly kind: "identifier"; readonly id: string }
  | { readonly kind: "wildcard" }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "relationInstance"; readonly atom: RelationAtom };


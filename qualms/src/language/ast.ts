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
  | SetStatement
  | ValidationStatement;

export interface TraitStatement {
  readonly kind: "trait";
  readonly id: string;
}

export interface RelationStatement {
  readonly kind: "relation";
  readonly id: string;
  readonly parameters: readonly RelationParameter[];
  readonly unique?: readonly string[];
}

export interface RelationParameter {
  readonly name?: string;
  readonly type: TypeExpr;
  readonly cardinality?: "one";
}

export interface CallableStatement {
  readonly kind: "action" | "predicate";
  readonly id: string;
  readonly parameters: readonly ParameterPattern[];
  readonly body: Block;
  readonly replace?: boolean;
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

export interface ValidationStatement {
  readonly kind: "validation";
  readonly id: string;
  readonly assertions: readonly ValidationAssertion[];
}

export type ValidationAssertion =
  | FactValidationAssertion
  | QueryValidationAssertion
  | PlayValidationAssertion;

export interface FactValidationAssertion {
  readonly kind: "fact";
  readonly negate: boolean;
  readonly atom: RelationAtom;
}

export interface QueryValidationAssertion {
  readonly kind: "query";
  readonly negate: boolean;
  readonly expression: Expression;
  readonly expectedBindings?: readonly EqualityExpression[];
}

export interface PlayValidationAssertion {
  readonly kind: "play";
  readonly atom: RelationAtom;
  readonly expected: "passed" | "failed";
  readonly expectedEffects?: readonly SetEffect[];
  readonly expectedReasons?: readonly Expression[];
}

export interface Block {
  readonly statements: readonly BodyStatement[];
}

export type BodyStatement = WhenStatement | SetStatement | EmitStatement | SucceedStatement | FailStatement;

export interface WhenStatement {
  readonly kind: "when";
  readonly condition: Expression;
  readonly body: Block;
}

export interface SucceedStatement {
  readonly kind: "succeed";
}

export interface FailStatement {
  readonly kind: "fail";
}

export interface SetEffect {
  readonly polarity: "assert" | "retract";
  readonly atom: RelationAtom;
}

export interface EmitStatement {
  readonly kind: "emit";
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
  | { readonly kind: "variable"; readonly id: string }
  | { readonly kind: "wildcard" }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "relationInstance"; readonly atom: RelationAtom };

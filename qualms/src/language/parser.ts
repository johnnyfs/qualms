import type {
  Block,
  BodyStatement,
  CallableStatement,
  EntityStatement,
  Expression,
  ExtendStatement,
  FailStatement,
  ParameterPattern,
  PassStatement,
  Program,
  RelationAtom,
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

type TokenType =
  | "identifier"
  | "string"
  | "number"
  | "lparen"
  | "rparen"
  | "lbrace"
  | "rbrace"
  | "comma"
  | "colon"
  | "semi"
  | "bang"
  | "amp"
  | "pipe"
  | "eqeq"
  | "eof";

interface Token {
  readonly type: TokenType;
  readonly image: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export class LanguageParseError extends Error {
  constructor(
    message: string,
    public readonly span?: {
      readonly offset: number;
      readonly line: number;
      readonly column: number;
    },
  ) {
    super(span ? `${message} at ${span.line}:${span.column}` : message);
    this.name = "LanguageParseError";
  }
}

export function parseProgram(source: string): Program {
  return new Parser(tokenize(source)).parseProgram();
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;

  const push = (type: TokenType, image: string, offset: number, startLine: number, startColumn: number): void => {
    tokens.push({ type, image, offset, line: startLine, column: startColumn });
  };

  const advance = (ch: string): void => {
    i++;
    if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  };

  while (i < source.length) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      advance(ch);
      continue;
    }
    if (ch === "-" && source[i + 1] === "-") {
      while (i < source.length && source[i] !== "\n") advance(source[i]!);
      continue;
    }

    const offset = i;
    const startLine = line;
    const startColumn = column;

    if (/[A-Za-z_]/.test(ch)) {
      let image = "";
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) {
        image += source[i]!;
        advance(source[i]!);
      }
      push("identifier", image, offset, startLine, startColumn);
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let image = "";
      while (i < source.length && /[0-9.]/.test(source[i]!)) {
        image += source[i]!;
        advance(source[i]!);
      }
      push("number", image, offset, startLine, startColumn);
      continue;
    }

    if (ch === '"') {
      let image = "";
      advance(ch);
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < source.length) {
          advance(source[i]!);
          image += source[i]!;
          advance(source[i]!);
        } else {
          image += source[i]!;
          advance(source[i]!);
        }
      }
      if (source[i] !== '"') {
        throw new LanguageParseError("unterminated string literal", {
          offset,
          line: startLine,
          column: startColumn,
        });
      }
      advance(source[i]!);
      push("string", image, offset, startLine, startColumn);
      continue;
    }

    if (ch === "=" && source[i + 1] === "=") {
      advance(ch);
      advance(source[i]!);
      push("eqeq", "==", offset, startLine, startColumn);
      continue;
    }

    const single: Record<string, TokenType> = {
      "(": "lparen",
      ")": "rparen",
      "{": "lbrace",
      "}": "rbrace",
      ",": "comma",
      ":": "colon",
      ";": "semi",
      "!": "bang",
      "&": "amp",
      "|": "pipe",
    };
    const type = single[ch];
    if (type) {
      advance(ch);
      push(type, ch, offset, startLine, startColumn);
      continue;
    }

    throw new LanguageParseError(`unexpected character '${ch}'`, {
      offset,
      line: startLine,
      column: startColumn,
    });
  }

  tokens.push({ type: "eof", image: "", offset: source.length, line, column });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parseProgram(): Program {
    const statements: TopLevelStatement[] = [];
    while (!this.at("eof")) {
      this.skipSemis();
      if (this.at("eof")) break;
      statements.push(this.topLevelStatement());
      this.skipSemis();
    }
    return { statements };
  }

  private topLevelStatement(): TopLevelStatement {
    if (this.matchKeyword("trait")) return this.traitStatement();
    if (this.matchKeyword("relation")) return this.relationStatement();
    if (this.matchKeyword("action")) return this.callableStatement("action");
    if (this.matchKeyword("predicate")) return this.callableStatement("predicate");
    if (this.matchKeyword("before")) return this.ruleStatement("before");
    if (this.matchKeyword("after")) return this.ruleStatement("after");
    if (this.matchKeyword("entity")) return this.entityStatement();
    if (this.matchKeyword("extend")) return this.extendStatement();
    if (this.matchKeyword("set")) return this.setStatement();
    this.fail(`expected top-level statement, got '${this.peek().image}'`);
  }

  private traitStatement(): TraitStatement {
    this.expectKeyword("trait");
    return { kind: "trait", id: this.identifier() };
  }

  private relationStatement(): RelationStatement {
    this.expectKeyword("relation");
    const id = this.identifier();
    this.expect("lparen");
    const parameters: RelationParameter[] = [];
    if (!this.at("rparen")) {
      parameters.push(this.relationParameter());
      while (this.consumeIf("comma")) parameters.push(this.relationParameter());
    }
    this.expect("rparen");
    return { kind: "relation", id, parameters };
  }

  private relationParameter(): RelationParameter {
    const cardinality = this.consumeKeywordIf("one") ? "one" : undefined;
    const type = this.typeExpr();
    return cardinality ? { type, cardinality } : { type };
  }

  private callableStatement(kind: "action" | "predicate"): CallableStatement {
    this.expectKeyword(kind);
    const id = this.identifier();
    const parameters = this.callParameters();
    const body = this.block();
    return { kind, id, parameters, body };
  }

  private ruleStatement(phase: "before" | "after"): RuleStatement {
    this.expectKeyword(phase);
    const target = this.identifier();
    const parameters = this.callParameters();
    const body = this.block();
    return { kind: "rule", phase, target, parameters, body };
  }

  private entityStatement(): EntityStatement {
    this.expectKeyword("entity");
    const id = this.identifier();
    return { kind: "entity", id, traits: this.traitSet() };
  }

  private extendStatement(): ExtendStatement {
    this.expectKeyword("extend");
    const id = this.identifier();
    return { kind: "extend", id, traits: this.traitSet() };
  }

  private traitSet(): string[] {
    this.expect("lbrace");
    const traits: string[] = [];
    if (!this.at("rbrace")) {
      traits.push(this.identifier());
      while (this.consumeIf("comma")) traits.push(this.identifier());
    }
    this.expect("rbrace");
    return traits;
  }

  private callParameters(): ParameterPattern[] {
    this.expect("lparen");
    const parameters: ParameterPattern[] = [];
    if (!this.at("rparen")) {
      parameters.push(this.parameterPattern());
      while (this.consumeIf("comma")) parameters.push(this.parameterPattern());
    }
    this.expect("rparen");
    return parameters;
  }

  private parameterPattern(): ParameterPattern {
    if (this.atKeyword("_")) {
      this.advance();
      const type = this.consumeIf("colon") ? this.typeExpr() : undefined;
      return this.withConstraints({ wildcard: true, ...(type ? { type } : {}), constraints: [] });
    }

    const name = this.identifier();
    let type: TypeExpr | undefined;
    if (this.consumeIf("colon")) type = this.typeExpr();
    return this.withConstraints({
      name,
      wildcard: false,
      ...(type ? { type } : {}),
      constraints: [],
    });
  }

  private withConstraints(pattern: ParameterPattern): ParameterPattern {
    const constraints: Expression[] = [];
    if (this.consumeIf("lbrace")) {
      if (!this.at("rbrace")) {
        constraints.push(this.expression());
        while (this.consumeIf("semi")) {
          if (this.at("rbrace")) break;
          constraints.push(this.expression());
        }
      }
      this.expect("rbrace");
    }
    return constraints.length > 0 ? { ...pattern, constraints } : pattern;
  }

  private block(): Block {
    this.expect("lbrace");
    const statements: BodyStatement[] = [];
    while (!this.at("rbrace")) {
      this.skipSemis();
      if (this.at("rbrace")) break;
      statements.push(this.bodyStatement());
      this.skipSemis();
    }
    this.expect("rbrace");
    return { statements };
  }

  private bodyStatement(): BodyStatement {
    if (this.matchKeyword("when")) return this.whenStatement();
    if (this.matchKeyword("set")) return this.setStatement();
    if (this.matchKeyword("pass")) return this.passStatement();
    if (this.matchKeyword("fail")) return this.failStatement();
    this.fail(`expected body statement, got '${this.peek().image}'`);
  }

  private whenStatement(): WhenStatement {
    this.expectKeyword("when");
    this.expect("lparen");
    const condition = this.expression();
    this.expect("rparen");
    const body = this.block();
    return { kind: "when", condition, body };
  }

  private passStatement(): PassStatement {
    this.expectKeyword("pass");
    this.consumeIf("semi");
    return { kind: "pass" };
  }

  private failStatement(): FailStatement {
    this.expectKeyword("fail");
    this.consumeIf("semi");
    return { kind: "fail" };
  }

  private setStatement(): SetStatement {
    this.expectKeyword("set");
    const effects: SetEffect[] = [];
    if (this.consumeIf("lbrace")) {
      while (!this.at("rbrace")) {
        this.skipSemis();
        if (this.at("rbrace")) break;
        effects.push(this.setEffect());
        this.consumeIf("semi");
      }
      this.expect("rbrace");
    } else {
      effects.push(this.setEffect());
      this.consumeIf("semi");
    }
    return { kind: "set", effects };
  }

  private setEffect(): SetEffect {
    const polarity = this.consumeIf("bang") ? "retract" : "assert";
    return { polarity, atom: this.relationAtom() };
  }

  private expression(): Expression {
    return this.orExpression();
  }

  private orExpression(): Expression {
    let left = this.andExpression();
    while (this.consumeIf("pipe")) {
      left = { kind: "binary", op: "|", left, right: this.andExpression() };
    }
    return left;
  }

  private andExpression(): Expression {
    let left = this.unaryExpression();
    while (this.consumeIf("amp")) {
      left = { kind: "binary", op: "&", left, right: this.unaryExpression() };
    }
    return left;
  }

  private unaryExpression(): Expression {
    if (this.consumeIf("bang")) {
      return { kind: "not", operand: this.unaryExpression() };
    }
    return this.comparisonExpression();
  }

  private comparisonExpression(): Expression {
    if (this.consumeIf("lparen")) {
      const grouped = this.expression();
      this.expect("rparen");
      return grouped;
    }

    const left = this.term();
    if (this.consumeIf("eqeq")) {
      return { kind: "equal", left, right: this.term() };
    }
    if (left.kind !== "relationInstance") {
      this.fail("expected relation call or equality expression");
    }
    return { kind: "relation", atom: left.atom };
  }

  private relationAtom(): RelationAtom {
    const relation = this.identifier();
    this.expect("lparen");
    const args: Term[] = [];
    if (!this.at("rparen")) {
      args.push(this.term());
      while (this.consumeIf("comma")) args.push(this.term());
    }
    this.expect("rparen");
    return { relation, args };
  }

  private term(): Term {
    if (this.consumeIf("string")) {
      return { kind: "string", value: this.previous().image };
    }
    if (this.consumeIf("number")) {
      return { kind: "number", value: Number(this.previous().image) };
    }
    if (this.atKeyword("_")) {
      this.advance();
      return { kind: "wildcard" };
    }

    const id = this.identifier();
    if (this.at("lparen")) {
      this.expect("lparen");
      const args: Term[] = [];
      if (!this.at("rparen")) {
        args.push(this.term());
        while (this.consumeIf("comma")) args.push(this.term());
      }
      this.expect("rparen");
      return { kind: "relationInstance", atom: { relation: id, args } };
    }
    return { kind: "identifier", id };
  }

  private typeExpr(): TypeExpr {
    if (this.consumeIf("lparen")) {
      const types = [this.typeExpr()];
      while (this.consumeIf("amp")) types.push(this.typeExpr());
      this.expect("rparen");
      return types.length === 1 ? types[0]! : { kind: "intersection", types };
    }
    return { kind: "named", id: this.identifier() };
  }

  private identifier(): string {
    const token = this.expect("identifier");
    return token.image;
  }

  private skipSemis(): void {
    while (this.consumeIf("semi")) {
      // no-op
    }
  }

  private matchKeyword(keyword: string): boolean {
    return this.atKeyword(keyword);
  }

  private expectKeyword(keyword: string): void {
    const token = this.expect("identifier");
    if (token.image !== keyword) {
      this.error(`expected '${keyword}', got '${token.image}'`, token);
    }
  }

  private consumeKeywordIf(keyword: string): boolean {
    if (!this.atKeyword(keyword)) return false;
    this.advance();
    return true;
  }

  private atKeyword(keyword: string): boolean {
    return this.peek().type === "identifier" && this.peek().image === keyword;
  }

  private at(type: TokenType): boolean {
    return this.peek().type === type;
  }

  private consumeIf(type: TokenType): boolean {
    if (!this.at(type)) return false;
    this.advance();
    return true;
  }

  private expect(type: TokenType): Token {
    const token = this.peek();
    if (token.type !== type) this.error(`expected ${type}, got '${token.image}'`, token);
    this.advance();
    return token;
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private previous(): Token {
    return this.tokens[this.index - 1]!;
  }

  private advance(): void {
    if (!this.at("eof")) this.index++;
  }

  private fail(message: string): never {
    this.error(message, this.peek());
  }

  private error(message: string, token: Token): never {
    throw new LanguageParseError(message, {
      offset: token.offset,
      line: token.line,
      column: token.column,
    });
  }
}


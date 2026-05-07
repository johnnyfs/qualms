/**
 * Chevrotain-based parser for the query DSL.
 *
 * Supported surface forms (ASCII shown; unicode equivalents parse identically):
 *
 *   Statements:
 *     ?- φ                                — predicate query (yes/no)
 *     { x | φ }                           — comprehension (single head var)
 *     { x : T | φ }                       — comprehension with trait/meta-type filter
 *     { x : T@layer | φ }                 — with scope addressing
 *     name(p1, p2, ...) :- φ              — named predicate definition
 *
 *   Expressions:
 *     φ & ψ      / φ ∧ ψ      / φ and ψ
 *     φ | ψ      / φ ∨ ψ      / φ or ψ
 *     not φ      / ¬ φ
 *     exists x [: T[@layer]]. φ           ∃
 *     forall x [: T[@layer]]. φ           ∀
 *     R(a, b, ...)
 *     t : T[@layer]
 *     a = b      a != b      a ≠ b
 *     s =~ /pat/flags
 *     like(s, "pat")
 *     a -[R]-> b           a -[R]->* b           a -[R]->+ b
 *     a <-[R]- b           a <-[R]-* b
 *     a -[R]- b            a -[R]-* b            (symmetric)
 *     a -[R1|R2]-> b       (alternation)
 *     (φ)                  true                  false
 *
 *   Terms:
 *     varName (lowercase identifier in argument position)
 *     "string-literal" / 42 / true / false
 *     entity.field         entity.Trait.field
 *
 * Identifier convention: identifiers in argument positions are variables;
 * literal entity ids and other string values must be quoted.
 */

import { CstParser, EmbeddedActionsParser, Lexer, type IToken, createToken } from "chevrotain";
import type {
  Expression,
  NamedPredicate,
  Query,
  Term,
  TraitFilter,
  Value,
} from "./ast.js";
import type { Layer } from "../core/types.js";

// ──────── Lexer ────────

const Identifier = createToken({
  name: "Identifier",
  pattern: /[A-Za-z_][A-Za-z0-9_]*/,
});

// Keywords (categoryMatches: Identifier so the parser treats them as identifiers
// when contextually appropriate, but the longer_alt lets the lexer prefer the
// keyword when it stands alone).

function keyword(name: string, lexeme: string): ReturnType<typeof createToken> {
  return createToken({
    name,
    pattern: new RegExp(lexeme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    longer_alt: Identifier,
  });
}

const Exists = keyword("Exists", "exists");
const Forall = keyword("Forall", "forall");
const Not = keyword("Not", "not");
const And = keyword("And", "and");
const Or = keyword("Or", "or");
const Like = keyword("Like", "like");
const True = keyword("True", "true");
const False = keyword("False", "false");
const PreludeLayer = keyword("PreludeLayer", "prelude");
const GameLayer = keyword("GameLayer", "game");
const SessionLayer = keyword("SessionLayer", "session");

// Unicode operator shortcuts (single-char, no longer_alt needed).
const ExistsU = createToken({ name: "ExistsU", pattern: /∃/ });
const ForallU = createToken({ name: "ForallU", pattern: /∀/ });
const NotU = createToken({ name: "NotU", pattern: /¬/ });
const AndU = createToken({ name: "AndU", pattern: /∧/ });
const OrU = createToken({ name: "OrU", pattern: /∨/ });
const NotEqU = createToken({ name: "NotEqU", pattern: /≠/ });

// Multi-char operators — declare BEFORE single-char to ensure longest match.
const Implies = createToken({ name: "Implies", pattern: /:-/ });
const QueryQ = createToken({ name: "QueryQ", pattern: /\?-/ });
const RegexEq = createToken({ name: "RegexEq", pattern: /=~/ });
const NotEq = createToken({ name: "NotEq", pattern: /!=/ });
const PathFwdOpen = createToken({ name: "PathFwdOpen", pattern: /-\[/ });
const PathBwdOpen = createToken({ name: "PathBwdOpen", pattern: /<-\[/ });
const PathClose = createToken({ name: "PathClose", pattern: /\]-(?:>)?/ });
// Single-char operators
const Eq = createToken({ name: "Eq", pattern: /=/ });
const Comma = createToken({ name: "Comma", pattern: /,/ });
const Semi = createToken({ name: "Semi", pattern: /;/ });
const Dot = createToken({ name: "Dot", pattern: /\./ });
const Colon = createToken({ name: "Colon", pattern: /:/ });
const At = createToken({ name: "At", pattern: /@/ });
const LParen = createToken({ name: "LParen", pattern: /\(/ });
const RParen = createToken({ name: "RParen", pattern: /\)/ });
const LBrace = createToken({ name: "LBrace", pattern: /\{/ });
const RBrace = createToken({ name: "RBrace", pattern: /\}/ });
const Pipe = createToken({ name: "Pipe", pattern: /\|/ });
const Amp = createToken({ name: "Amp", pattern: /&/ });
const Star = createToken({ name: "Star", pattern: /\*/ });
const Plus = createToken({ name: "Plus", pattern: /\+/ });

// Literals
const StringLiteral = createToken({
  name: "StringLiteral",
  pattern: /"(?:[^"\\]|\\.)*"/,
});
const NumberLiteral = createToken({
  name: "NumberLiteral",
  pattern: /-?[0-9]+(?:\.[0-9]+)?/,
});
const RegexLiteral = createToken({
  name: "RegexLiteral",
  pattern: /\/(?:[^\/\\]|\\.)+\/[gimsuy]*/,
});

// Whitespace / comments
const Whitespace = createToken({
  name: "Whitespace",
  pattern: /[\s]+/,
  group: Lexer.SKIPPED,
});
const LineComment = createToken({
  name: "LineComment",
  pattern: /#[^\n]*/,
  group: Lexer.SKIPPED,
});

// Order matters: longer multi-char tokens before their prefix tokens.
const allTokens = [
  Whitespace,
  LineComment,
  // multi-char first
  Implies,
  QueryQ,
  RegexEq,
  NotEq,
  PathBwdOpen,
  PathFwdOpen,
  PathClose,
  // unicode
  ExistsU,
  ForallU,
  NotU,
  AndU,
  OrU,
  NotEqU,
  // literals before identifier/keywords because regex starts with `/` which has no overlap
  RegexLiteral,
  StringLiteral,
  NumberLiteral,
  // keywords (must precede Identifier)
  Exists,
  Forall,
  Not,
  And,
  Or,
  Like,
  True,
  False,
  PreludeLayer,
  GameLayer,
  SessionLayer,
  Identifier,
  // single-char
  Eq,
  Comma,
  Semi,
  Dot,
  Colon,
  At,
  LParen,
  RParen,
  LBrace,
  RBrace,
  Pipe,
  Amp,
  Star,
  Plus,
];

const QualmsLexer = new Lexer(allTokens);

// ──────── Parser (embedded actions: build the AST directly) ────────

export type Statement =
  | { kind: "query"; query: Query }
  | { kind: "named_predicate"; predicate: NamedPredicate };

export class ParseError extends Error {
  constructor(message: string, public readonly span?: { startOffset?: number; endOffset?: number; line?: number; column?: number }) {
    super(message);
    this.name = "ParseError";
  }
}

function unquoteString(token: IToken): string {
  const raw = token.image ?? "";
  if (raw.length < 2) return "";
  return raw.slice(1, -1).replace(/\\(.)/g, "$1");
}

function parseLayer(token: IToken): Layer {
  // Use tokenType so we can survive the grammar-recording phase where image
  // may be a placeholder.
  const name = token.tokenType?.name;
  if (name === "PreludeLayer") return "prelude";
  if (name === "GameLayer") return "game";
  if (name === "SessionLayer") return "session";
  return "prelude"; // safe fallback during recording
}

function parseRegex(token: IToken): { pattern: string; flags: string } {
  const raw = token.image ?? "";
  if (raw.length < 2) return { pattern: "", flags: "" };
  const lastSlash = raw.lastIndexOf("/");
  return {
    pattern: raw.slice(1, lastSlash),
    flags: raw.slice(lastSlash + 1),
  };
}

class QualmsParser extends EmbeddedActionsParser {
  constructor() {
    super(allTokens, { recoveryEnabled: false, maxLookahead: 4 });
    this.performSelfAnalysis();
  }

  // Top-level statement.
  public statement = this.RULE("statement", (): Statement => {
    return this.OR([
      // Predicate query: ?- expression
      {
        ALT: () => {
          this.CONSUME(QueryQ);
          const body = this.SUBRULE(this.expression);
          return { kind: "query", query: { head: [], body } };
        },
      },
      // Comprehension: { var [: TraitFilter] | expression }
      {
        ALT: () => {
          this.CONSUME(LBrace);
          const head: string[] = [];
          const headVar = this.CONSUME(Identifier).image;
          head.push(headVar);
          let filter: TraitFilter | undefined;
          this.OPTION(() => {
            this.CONSUME(Colon);
            filter = this.SUBRULE(this.traitFilter);
          });
          this.CONSUME(Pipe);
          const inner = this.SUBRULE2(this.expression);
          this.CONSUME(RBrace);
          const body: Expression = filter
            ? {
                type: "and",
                left: {
                  type: "traitOf",
                  entity: { type: "var", name: headVar },
                  filter,
                },
                right: inner,
              }
            : inner;
          return { kind: "query", query: { head, body } };
        },
      },
      // Named predicate definition: name(p1, p2, ...) :- expression
      {
        ALT: () => {
          const name = this.CONSUME2(Identifier).image;
          this.CONSUME2(LParen);
          const parameters: string[] = [];
          this.OPTION2(() => {
            parameters.push(this.CONSUME3(Identifier).image);
            this.MANY(() => {
              this.CONSUME(Comma);
              parameters.push(this.CONSUME4(Identifier).image);
            });
          });
          this.CONSUME(RParen);
          this.CONSUME(Implies);
          const body = this.SUBRULE3(this.expression);
          return { kind: "named_predicate", predicate: { name, parameters, body } };
        },
      },
    ]);
  });

  // expression := orExpr  (right-associative is fine)
  public expression = this.RULE("expression", (): Expression => {
    return this.SUBRULE(this.orExpr);
  });

  private orExpr = this.RULE("orExpr", (): Expression => {
    let left = this.SUBRULE(this.andExpr);
    this.MANY(() => {
      this.OR([{ ALT: () => this.CONSUME(Or) }, { ALT: () => this.CONSUME(Pipe) }, { ALT: () => this.CONSUME(OrU) }]);
      const right = this.SUBRULE2(this.andExpr);
      left = { type: "or", left, right };
    });
    return left;
  });

  private andExpr = this.RULE("andExpr", (): Expression => {
    let left = this.SUBRULE(this.notExpr);
    this.MANY(() => {
      this.OR([{ ALT: () => this.CONSUME(And) }, { ALT: () => this.CONSUME(Amp) }, { ALT: () => this.CONSUME(AndU) }]);
      const right = this.SUBRULE2(this.notExpr);
      left = { type: "and", left, right };
    });
    return left;
  });

  private notExpr = this.RULE("notExpr", (): Expression => {
    let negated = false;
    this.MANY(() => {
      this.OR([{ ALT: () => this.CONSUME(Not) }, { ALT: () => this.CONSUME(NotU) }]);
      negated = !negated;
    });
    const inner = this.SUBRULE(this.atomicExpr);
    return negated ? { type: "not", operand: inner } : inner;
  });

  /**
   * Atomic expressions: parens, quantifiers, then term-led forms (relation calls,
   * trait-of, equality, regex, like, path patterns).
   */
  private atomicExpr = this.RULE("atomicExpr", (): Expression => {
    return this.OR([
      { ALT: () => this.SUBRULE(this.parenExpr) },
      { ALT: () => this.SUBRULE(this.quantifierExpr) },
      // Literal true/false ONLY when not followed by a term continuation (an
      // operator that would push us into termLedExpr).
      {
        GATE: () => {
          const t1 = this.LA(1).tokenType;
          if (t1 !== True && t1 !== False) return false;
          const t2 = this.LA(2).tokenType;
          return (
            t2 !== Eq &&
            t2 !== NotEq &&
            t2 !== NotEqU &&
            t2 !== RegexEq &&
            t2 !== Colon &&
            t2 !== PathFwdOpen &&
            t2 !== PathBwdOpen &&
            t2 !== Dot
          );
        },
        ALT: () => this.SUBRULE(this.literalBoolExpr),
      },
      { ALT: () => this.SUBRULE(this.likeCall) },
      { ALT: () => this.SUBRULE(this.termLedExpr) },
    ]);
  });

  private parenExpr = this.RULE("parenExpr", (): Expression => {
    this.CONSUME(LParen);
    const inner = this.SUBRULE(this.expression);
    this.CONSUME(RParen);
    return inner;
  });

  private literalBoolExpr = this.RULE("literalBoolExpr", (): Expression => {
    return this.OR([
      {
        ALT: () => {
          this.CONSUME(True);
          return { type: "literal", value: true } as Expression;
        },
      },
      {
        ALT: () => {
          this.CONSUME(False);
          return { type: "literal", value: false } as Expression;
        },
      },
    ]);
  });

  private quantifierExpr = this.RULE("quantifierExpr", (): Expression => {
    const isExists = this.OR([
      {
        ALT: () => {
          this.CONSUME(Exists);
          return true;
        },
      },
      {
        ALT: () => {
          this.CONSUME(ExistsU);
          return true;
        },
      },
      {
        ALT: () => {
          this.CONSUME(Forall);
          return false;
        },
      },
      {
        ALT: () => {
          this.CONSUME(ForallU);
          return false;
        },
      },
    ]);
    const variable = this.CONSUME(Identifier).image;
    let filter: TraitFilter | undefined;
    this.OPTION(() => {
      this.CONSUME(Colon);
      filter = this.SUBRULE(this.traitFilter);
    });
    this.CONSUME(Dot);
    const body = this.SUBRULE(this.expression);
    return isExists
      ? { type: "exists", variable, ...(filter ? { traitFilter: filter } : {}), body }
      : { type: "forall", variable, ...(filter ? { traitFilter: filter } : {}), body };
  });

  private traitFilter = this.RULE("traitFilter", (): TraitFilter => {
    const name = this.CONSUME(Identifier).image;
    const filter: TraitFilter = { name };
    this.OPTION(() => {
      this.CONSUME(At);
      const layerToken = this.OR([
        { ALT: () => this.CONSUME(PreludeLayer) },
        { ALT: () => this.CONSUME(GameLayer) },
        { ALT: () => this.CONSUME(SessionLayer) },
      ]);
      filter.layer = parseLayer(layerToken);
    });
    return filter;
  });

  /**
   * Forms led by a term — either:
   *   - relation call:    name(args)
   *   - traitOf:          term : TraitFilter
   *   - equality:         term = term  /  term != term
   *   - regex:            term =~ /pat/
   *   - path:             term -[R...]-> term  etc.
   *   - bare term:        not allowed at top level
   *
   * We disambiguate by parsing a leading "head": either an identifier followed
   * by `(` (relation call) OR a regular term, then look at the operator.
   */
  private termLedExpr = this.RULE("termLedExpr", (): Expression => {
    return this.OR([
      // Relation call: identifier '(' args ')'  — backtracking to avoid stealing identifiers used as terms.
      {
        GATE: () => this.LA(1).tokenType === Identifier && this.LA(2).tokenType === LParen,
        ALT: () => this.SUBRULE(this.relationCall),
      },
      // Otherwise: term-led form (term followed by an operator).
      { ALT: () => this.SUBRULE(this.termComparison) },
    ]);
  });

  private relationCall = this.RULE("relationCall", (): Expression => {
    const name = this.CONSUME(Identifier).image;
    this.CONSUME(LParen);
    const args: Term[] = [];
    this.OPTION(() => {
      args.push(this.SUBRULE(this.term));
      this.MANY(() => {
        this.CONSUME(Comma);
        args.push(this.SUBRULE2(this.term));
      });
    });
    this.CONSUME(RParen);
    return { type: "relation", relation: name, args };
  });

  private likeCall = this.RULE("likeCall", (): Expression => {
    this.CONSUME(Like);
    this.CONSUME(LParen);
    const subject = this.SUBRULE(this.term);
    this.CONSUME(Comma);
    const patternTok = this.CONSUME(StringLiteral);
    this.CONSUME(RParen);
    return { type: "like", subject, pattern: unquoteString(patternTok) };
  });

  private termComparison = this.RULE("termComparison", (): Expression => {
    const left = this.SUBRULE(this.term);
    return this.OR([
      {
        ALT: () => {
          this.CONSUME(Colon);
          const filter = this.SUBRULE(this.traitFilter);
          return { type: "traitOf", entity: left, filter } as Expression;
        },
      },
      {
        ALT: () => {
          this.CONSUME(Eq);
          const right = this.SUBRULE2(this.term);
          return { type: "equal", left, right } as Expression;
        },
      },
      {
        ALT: () => {
          this.OR2([
            { ALT: () => this.CONSUME(NotEq) },
            { ALT: () => this.CONSUME(NotEqU) },
          ]);
          const right = this.SUBRULE3(this.term);
          return { type: "notEqual", left, right } as Expression;
        },
      },
      {
        ALT: () => {
          this.CONSUME(RegexEq);
          const r = this.CONSUME(RegexLiteral);
          const { pattern, flags } = parseRegex(r);
          return {
            type: "regex",
            subject: left,
            pattern,
            ...(flags ? { flags } : {}),
          } as Expression;
        },
      },
      // Path patterns (forward / symmetric × 1/+/*)
      {
        ALT: () => {
          this.CONSUME(PathFwdOpen);
          const rels = this.SUBRULE(this.pathRelations);
          const closeTok = this.CONSUME(PathClose);
          const isForward = closeTok.image === "]->";
          const quant = this.SUBRULE(this.pathQuantifier);
          const right = this.SUBRULE4(this.term);
          return {
            type: "path",
            from: left,
            to: right,
            relations: rels,
            direction: isForward ? "forward" : "symmetric",
            quantifier: quant,
          } as Expression;
        },
      },
      // Path patterns (backward × 1/+/*)
      {
        ALT: () => {
          this.CONSUME(PathBwdOpen);
          const rels = this.SUBRULE2(this.pathRelations);
          this.CONSUME2(PathClose); // accept ]- or ]-> for backward close
          const quant = this.SUBRULE2(this.pathQuantifier);
          const right = this.SUBRULE5(this.term);
          return {
            type: "path",
            from: left,
            to: right,
            relations: rels,
            direction: "backward",
            quantifier: quant,
          } as Expression;
        },
      },
    ]);
  });

  private pathRelations = this.RULE("pathRelations", (): string[] => {
    const out: string[] = [];
    out.push(this.CONSUME(Identifier).image);
    this.MANY(() => {
      this.CONSUME(Pipe);
      out.push(this.CONSUME2(Identifier).image);
    });
    return out;
  });

  private pathQuantifier = this.RULE("pathQuantifier", (): "1" | "*" | "+" => {
    let quant: "1" | "*" | "+" = "1";
    this.OPTION(() => {
      this.OR([
        {
          ALT: () => {
            this.CONSUME(Star);
            quant = "*";
          },
        },
        {
          ALT: () => {
            this.CONSUME(Plus);
            quant = "+";
          },
        },
      ]);
    });
    return quant;
  });

  // ──────── Terms ────────

  private term = this.RULE("term", (): Term => {
    let head: Term = this.OR([
      {
        ALT: () => {
          const tok = this.CONSUME(StringLiteral);
          return { type: "value", value: unquoteString(tok) } as Term;
        },
      },
      {
        ALT: () => {
          const tok = this.CONSUME(NumberLiteral);
          return { type: "value", value: Number(tok.image) } as Term;
        },
      },
      {
        ALT: () => {
          this.CONSUME(True);
          return { type: "value", value: true } as Term;
        },
      },
      {
        ALT: () => {
          this.CONSUME(False);
          return { type: "value", value: false } as Term;
        },
      },
      {
        ALT: () => {
          const ident = this.CONSUME(Identifier).image;
          return { type: "var", name: ident } as Term;
        },
      },
    ]);
    // Field access chain: term ('.' Identifier)*  — first Dot is field on entity;
    // the rare two-segment form `entity.Trait.field` qualifies.
    let dots = 0;
    let firstSegment: string | undefined;
    let secondSegment: string | undefined;
    this.MANY(() => {
      this.CONSUME(Dot);
      const seg = this.CONSUME2(Identifier).image;
      if (dots === 0) firstSegment = seg;
      else if (dots === 1) secondSegment = seg;
      else throw new ParseError("too many dots in field access (max 2)", undefined);
      dots++;
    });
    if (firstSegment === undefined) return head;
    if (secondSegment === undefined) {
      return { type: "field", entity: head, field: firstSegment } as Term;
    }
    return {
      type: "field",
      entity: head,
      trait: firstSegment,
      field: secondSegment,
    } as Term;
  });
}

const parserInstance = new QualmsParser();

// ──────── Public API ────────

export function tokenize(input: string): { tokens: IToken[]; errors: { message: string; offset: number; line?: number; column?: number }[] } {
  const result = QualmsLexer.tokenize(input);
  return {
    tokens: result.tokens,
    errors: result.errors.map((e) => ({
      message: e.message,
      offset: e.offset,
      ...(e.line !== undefined ? { line: e.line } : {}),
      ...(e.column !== undefined ? { column: e.column } : {}),
    })),
  };
}

export function parseStatement(input: string): Statement {
  const { tokens, errors } = tokenize(input);
  if (errors.length > 0) {
    const e = errors[0]!;
    throw new ParseError(`lex error: ${e.message}`, { startOffset: e.offset });
  }
  parserInstance.input = tokens;
  const ast = parserInstance.statement();
  if (parserInstance.errors.length > 0) {
    const e = parserInstance.errors[0]!;
    const tok = e.token;
    throw new ParseError(
      `parse error: ${e.message}`,
      tok && tok.startOffset !== undefined
        ? {
            startOffset: tok.startOffset,
            ...(tok.endOffset !== undefined ? { endOffset: tok.endOffset } : {}),
            ...(tok.startLine !== undefined ? { line: tok.startLine } : {}),
            ...(tok.startColumn !== undefined ? { column: tok.startColumn } : {}),
          }
        : undefined,
    );
  }
  return ast as Statement;
}

export function parseQuery(input: string): Query {
  const stmt = parseStatement(input);
  if (stmt.kind !== "query") {
    throw new ParseError(`expected a query, got a named predicate definition`);
  }
  return stmt.query;
}

export function parseNamedPredicate(input: string): NamedPredicate {
  const stmt = parseStatement(input);
  if (stmt.kind !== "named_predicate") {
    throw new ParseError(`expected a named predicate, got a query`);
  }
  return stmt.predicate;
}

export function parseExpression(input: string): Expression {
  // Wrap as a yes/no query and extract the body. Handy for tests.
  const wrapped = parseQuery(`?- ${input}`);
  return wrapped.body;
}

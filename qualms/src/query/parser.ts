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
  ActionDefSpec,
  ActionPatternSpec,
  Effect,
  EntityDefSpec,
  Expression,
  FieldDefSpec,
  KindDefSpec,
  MutationStatement,
  NamedPredicate,
  ParameterDefSpec,
  Query,
  RelationDefSpec,
  RuleDefSpec,
  RulebookDefSpec,
  Term,
  TraitDefSpec,
  TraitFilter,
  TraitGrantSpec,
  UndefTargetKind,
  Value,
} from "./ast.js";
import { isUndefTargetKind } from "./ast.js";
import type { Module } from "../core/types.js";

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
// Mutation-statement keywords
const Def = keyword("Def", "def");
const Undef = keyword("Undef", "undef");
const Assert = keyword("Assert", "assert");
const Retract = keyword("Retract", "retract");
const In = keyword("In", "in");
// Statement-verb keywords (DSL v2). Hard-reserved at the lexer level so the
// statement dispatcher and a few inline-keyword contexts (e.g. `null` value)
// can recognize them by token type.
const Query = keyword("Query", "query");
const Show = keyword("Show", "show");
const Null = keyword("Null", "null");

// Unicode operator shortcuts (single-char, no longer_alt needed).
const ExistsU = createToken({ name: "ExistsU", pattern: /∃/ });
const ForallU = createToken({ name: "ForallU", pattern: /∀/ });
const NotU = createToken({ name: "NotU", pattern: /¬/ });
const AndU = createToken({ name: "AndU", pattern: /∧/ });
const OrU = createToken({ name: "OrU", pattern: /∨/ });
const NotEqU = createToken({ name: "NotEqU", pattern: /≠/ });

// Multi-char operators — declare BEFORE single-char to ensure longest match.
const Implies = createToken({ name: "Implies", pattern: /:-/ });
const Walrus = createToken({ name: "Walrus", pattern: /:=/ });
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
const LBracket = createToken({ name: "LBracket", pattern: /\[/ });
const RBracket = createToken({ name: "RBracket", pattern: /\]/ });
const Pipe = createToken({ name: "Pipe", pattern: /\|/ });
const Amp = createToken({ name: "Amp", pattern: /&/ });
const Star = createToken({ name: "Star", pattern: /\*/ });
const Plus = createToken({ name: "Plus", pattern: /\+/ });
const LessThan = createToken({ name: "LessThan", pattern: /</ });
const GreaterThan = createToken({ name: "GreaterThan", pattern: />/ });
const QuestionMark = createToken({ name: "QuestionMark", pattern: /\?/ });

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
  Walrus,
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
  Def,
  Undef,
  Assert,
  Retract,
  In,
  Query,
  Show,
  Null,
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
  LBracket,
  RBracket,
  Pipe,
  Amp,
  Star,
  Plus,
  LessThan,
  GreaterThan,
  QuestionMark,
];

const QualmsLexer = new Lexer(allTokens);

// ──────── Parser (embedded actions: build the AST directly) ────────

export type Statement =
  | { kind: "query"; query: Query }
  | { kind: "named_predicate"; predicate: NamedPredicate }
  | { kind: "mutation"; mutation: MutationStatement }
  | { kind: "exists"; body: Expression }
  | { kind: "show"; targetKind: UndefTargetKind; name: string };

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

function parseLayer(token: IToken): Module {
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
    super(allTokens, { recoveryEnabled: false, maxLookahead: 5 });
    this.performSelfAnalysis();
  }

  // Top-level statement (DSL v2). Statements end with `;` (consumed by the caller).
  public statement = this.RULE("statement", (): Statement => {
    return this.OR([
      // query { head-vars | expression }
      {
        ALT: () => {
          this.CONSUME(Query);
          this.CONSUME(LBrace);
          const head: string[] = [];
          head.push(this.CONSUME(Identifier).image);
          this.MANY(() => {
            this.CONSUME(Comma);
            head.push(this.CONSUME2(Identifier).image);
          });
          let filter: TraitFilter | undefined;
          this.OPTION(() => {
            this.CONSUME(Colon);
            filter = this.SUBRULE(this.traitFilter);
          });
          this.CONSUME(Pipe);
          const inner = this.SUBRULE(this.expression);
          this.CONSUME(RBrace);
          const body: Expression = filter
            ? {
                type: "and",
                left: {
                  type: "traitOf",
                  entity: { type: "var", name: head[0]! },
                  filter,
                },
                right: inner,
              }
            : inner;
          return { kind: "query", query: { head, body } };
        },
      },
      // exists { expression }   (or ∃ { expression })
      {
        ALT: () => {
          this.OR2([
            { ALT: () => this.CONSUME(Exists) },
            { ALT: () => this.CONSUME(ExistsU) },
          ]);
          this.CONSUME2(LBrace);
          const body = this.SUBRULE2(this.expression);
          this.CONSUME2(RBrace);
          return { kind: "exists", body };
        },
      },
      // show <target-kind> <name>
      {
        ALT: () => {
          this.CONSUME(Show);
          const kindTok = this.CONSUME3(Identifier).image;
          const name = this.CONSUME4(Identifier).image;
          return {
            kind: "show",
            targetKind: kindTok as UndefTargetKind,
            name,
          };
        },
      },
      // Mutation: assert / retract relation calls
      {
        ALT: () => {
          this.CONSUME(Assert);
          const { relation, args } = this.SUBRULE(this.relationCallParts);
          return {
            kind: "mutation",
            mutation: { type: "assert", relation, args },
          };
        },
      },
      {
        ALT: () => {
          this.CONSUME(Retract);
          const { relation, args } = this.SUBRULE2(this.relationCallParts);
          return {
            kind: "mutation",
            mutation: { type: "retract", relation, args },
          };
        },
      },
      // Mutation: def <kind> ...
      {
        ALT: () => {
          this.CONSUME(Def);
          return this.SUBRULE(this.defStmt);
        },
      },
      // Mutation: undef <kind> <name>  (kind validated post-parse to survive recording phase)
      {
        ALT: () => {
          this.CONSUME(Undef);
          const kindTok = this.CONSUME5(Identifier).image;
          const name = this.CONSUME6(Identifier).image;
          return {
            kind: "mutation",
            mutation: {
              type: "undef",
              targetKind: kindTok as UndefTargetKind,
              name,
            },
          };
        },
      },
      // Field assign: term := value  (gated by Walrus lookahead so we don't shadow the named-predicate alternative)
      {
        GATE: () => {
          if (this.LA(1).tokenType !== Identifier) return false;
          let i = 2;
          while (i <= 6 && this.LA(i).tokenType === Dot) {
            i += 2;
          }
          return this.LA(i).tokenType === Walrus;
        },
        ALT: () => {
          const target = this.SUBRULE(this.term);
          this.CONSUME(Walrus);
          const value = this.SUBRULE2(this.term);
          return {
            kind: "mutation",
            mutation: { type: "fieldAssign", target, value },
          };
        },
      },
      // Named predicate definition: name(p1, p2, ...) :- expression
      {
        ALT: () => {
          const name = this.CONSUME7(Identifier).image;
          this.CONSUME2(LParen);
          const parameters: string[] = [];
          this.OPTION2(() => {
            parameters.push(this.CONSUME8(Identifier).image);
            this.MANY2(() => {
              this.CONSUME2(Comma);
              parameters.push(this.CONSUME9(Identifier).image);
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
      filter.module = parseLayer(layerToken);
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
    const { relation, args } = this.SUBRULE(this.relationCallParts);
    return { type: "relation", relation, args };
  });

  /** Shared parts: identifier `(` arg-list `)` — used by query relation calls and assert/retract mutations. */
  private relationCallParts = this.RULE(
    "relationCallParts",
    (): { relation: string; args: Term[] } => {
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
      return { relation: name, args };
    },
  );

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
          this.CONSUME(Null);
          return { type: "value", value: null } as Term;
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

  // ──────── Mutation grammar ────────

  /**
   * `def <kind> ...` body. The leading `Def` token has already been consumed by
   * the statement-level alternative. Each per-kind alternative dispatches to its
   * own sub-rule so CONSUME indices stay tractable.
   */
  private defStmt = this.RULE("defStmt", (): Statement => {
    return this.OR([
      {
        GATE: () => this.LA(1).image === "trait",
        ALT: () => this.SUBRULE(this.defTraitStmt),
      },
      {
        GATE: () => this.LA(1).image === "relation",
        ALT: () => this.SUBRULE(this.defRelationStmt),
      },
      {
        GATE: () => this.LA(1).image === "action",
        ALT: () => this.SUBRULE(this.defActionStmt),
      },
      {
        GATE: () => this.LA(1).image === "kind",
        ALT: () => this.SUBRULE(this.defKindStmt),
      },
      {
        GATE: () => this.LA(1).image === "rule",
        ALT: () => this.SUBRULE(this.defRuleStmt),
      },
      {
        GATE: () => this.LA(1).image === "rulebook",
        ALT: () => this.SUBRULE(this.defRulebookStmt),
      },
      {
        GATE: () => this.LA(1).image === "entity",
        ALT: () => this.SUBRULE(this.defEntityStmt),
      },
    ]);
  });

  // ──────── DSL v2 def-statement sub-rules ────────

  private defTraitStmt = this.RULE("defTraitStmt", (): Statement => {
    this.CONSUME(Identifier); // 'trait'
    const id = this.CONSUME2(Identifier).image;
    const spec = this.SUBRULE(this.defTraitBody);
    return { kind: "mutation", mutation: { type: "defTrait", spec: { id, ...spec } } };
  });

  private defRelationStmt = this.RULE("defRelationStmt", (): Statement => {
    this.CONSUME(Identifier); // 'relation'
    const id = this.CONSUME2(Identifier).image;
    const parameters = this.SUBRULE(this.paramList);
    // Optional return-type annotation (documentation-only for now).
    this.OPTION(() => {
      this.CONSUME(Colon);
      this.SUBRULE(this.typeRef);
    });
    const body = this.SUBRULE(this.defRelationBody);
    return {
      kind: "mutation",
      mutation: { type: "defRelation", spec: { id, parameters, ...body } },
    };
  });

  private defActionStmt = this.RULE("defActionStmt", (): Statement => {
    this.CONSUME(Identifier); // 'action'
    const id = this.CONSUME2(Identifier).image;
    const parameters = this.SUBRULE(this.paramList);
    // Optional return-type annotation (documentation-only for now).
    this.OPTION(() => {
      this.CONSUME(Colon);
      this.SUBRULE(this.typeRef);
    });
    const body = this.SUBRULE(this.defActionBody);
    return {
      kind: "mutation",
      mutation: { type: "defAction", spec: { id, parameters, ...body } },
    };
  });

  private defKindStmt = this.RULE("defKindStmt", (): Statement => {
    this.CONSUME(Identifier); // 'kind'
    const id = this.CONSUME2(Identifier).image;
    const traits: string[] = [];
    this.OPTION(() => {
      this.CONSUME(Colon);
      traits.push(this.CONSUME3(Identifier).image);
      this.MANY(() => {
        this.CONSUME(Comma);
        traits.push(this.CONSUME4(Identifier).image);
      });
    });
    const body = this.SUBRULE(this.defKindBody);
    return {
      kind: "mutation",
      mutation: { type: "defKind", spec: { id, traits, ...body } },
    };
  });

  private defRuleStmt = this.RULE("defRuleStmt", (): Statement => {
    this.CONSUME(Identifier); // 'rule'
    const id = this.CONSUME2(Identifier).image;
    this.CONSUME(In);
    const rulebook = this.CONSUME3(Identifier).image;
    const body = this.SUBRULE(this.defRuleBody);
    return {
      kind: "mutation",
      mutation: { type: "defRule", spec: { id, rulebook, ...body } },
    };
  });

  private defRulebookStmt = this.RULE("defRulebookStmt", (): Statement => {
    this.CONSUME(Identifier); // 'rulebook'
    const id = this.CONSUME2(Identifier).image;
    this.OPTION(() => {
      this.CONSUME(LBrace);
      this.CONSUME(RBrace);
    });
    return { kind: "mutation", mutation: { type: "defRulebook", spec: { id } } };
  });

  private defEntityStmt = this.RULE("defEntityStmt", (): Statement => {
    this.CONSUME(Identifier); // 'entity'
    const id = this.CONSUME2(Identifier).image;
    let kindRef: string | undefined;
    this.OPTION(() => {
      this.CONSUME(Colon);
      kindRef = this.CONSUME3(Identifier).image;
    });
    const body = this.SUBRULE(this.defEntityBody);
    return {
      kind: "mutation",
      mutation: {
        type: "defEntity",
        spec: { id, ...(kindRef !== undefined ? { kind: kindRef } : {}), ...body },
      },
    };
  });

  // ──────── Parameter lists (relations, actions) ────────

  private paramList = this.RULE("paramList", (): ParameterDefSpec[] => {
    this.CONSUME(LParen);
    const out: ParameterDefSpec[] = [];
    this.OPTION(() => {
      out.push(this.SUBRULE(this.param));
      this.MANY(() => {
        this.CONSUME(Comma);
        out.push(this.SUBRULE2(this.param));
      });
    });
    this.CONSUME(RParen);
    return out;
  });

  private param = this.RULE("param", (): ParameterDefSpec => {
    const id = this.CONSUME(Identifier).image;
    let type: string | undefined;
    this.OPTION(() => {
      this.CONSUME(Colon);
      type = this.SUBRULE(this.typeRef);
    });
    let hasDefault = false;
    let defaultValue: unknown = undefined;
    this.OPTION2(() => {
      this.CONSUME(Eq);
      defaultValue = this.SUBRULE(this.value);
      hasDefault = true;
    });
    const out: ParameterDefSpec = { id };
    if (type !== undefined) out.type = type;
    if (hasDefault) {
      out.default = defaultValue;
      out.hasDefault = true;
    }
    return out;
  });

  // ──────── Type reference parsing ────────
  // typeRef := Identifier ("<" typeRef ">")? "?"?
  // Stored as a single string (e.g. "ref<Location>?").

  private typeRef = this.RULE("typeRef", (): string => {
    let out = this.CONSUME(Identifier).image;
    this.OPTION(() => {
      this.CONSUME(LessThan);
      out += "<" + this.SUBRULE(this.typeRef) + ">";
      this.CONSUME(GreaterThan);
    });
    this.OPTION2(() => {
      this.CONSUME(QuestionMark);
      out += "?";
    });
    return out;
  });

  // ──────── Value parsing (used in field defaults, entity overrides, kind overrides, metadata) ────────

  private value = this.RULE("value", (): unknown => {
    return this.OR([
      { ALT: () => unquoteString(this.CONSUME(StringLiteral)) },
      { ALT: () => Number(this.CONSUME(NumberLiteral).image) },
      {
        ALT: () => {
          this.CONSUME(True);
          return true;
        },
      },
      {
        ALT: () => {
          this.CONSUME(False);
          return false;
        },
      },
      {
        ALT: () => {
          this.CONSUME(Null);
          return null;
        },
      },
      { ALT: () => this.SUBRULE(this.valueObject) },
      { ALT: () => this.SUBRULE(this.valueArray) },
      // Bare identifier — treated as a string (for symbolic refs).
      { ALT: () => this.CONSUME(Identifier).image },
    ]);
  });

  private valueObject = this.RULE("valueObject", (): Record<string, unknown> => {
    this.CONSUME(LBrace);
    const out: Record<string, unknown> = {};
    this.OPTION(() => {
      const first = this.SUBRULE(this.valueObjectEntry);
      if (first) out[first.key] = first.value;
      this.MANY(() => {
        this.CONSUME(Comma);
        const next = this.SUBRULE2(this.valueObjectEntry);
        if (next) out[next.key] = next.value;
      });
    });
    this.CONSUME(RBrace);
    return out;
  });

  private valueObjectEntry = this.RULE(
    "valueObjectEntry",
    (): { key: string; value: unknown } => {
      const key = this.OR([
        { ALT: () => unquoteString(this.CONSUME(StringLiteral)) },
        { ALT: () => this.CONSUME(Identifier).image },
      ]);
      this.CONSUME(Colon);
      const value = this.SUBRULE(this.value);
      return { key, value };
    },
  );

  private valueArray = this.RULE("valueArray", (): unknown[] => {
    this.CONSUME(LBracket);
    const out: unknown[] = [];
    this.OPTION(() => {
      out.push(this.SUBRULE(this.value));
      this.MANY(() => {
        this.CONSUME(Comma);
        out.push(this.SUBRULE2(this.value));
      });
    });
    this.CONSUME(RBracket);
    return out;
  });

  // ──────── Action call (for rule.match values) ────────

  private actionCallValue = this.RULE("actionCallValue", (): ActionPatternSpec => {
    const action = this.CONSUME(Identifier).image;
    this.CONSUME(LParen);
    const args: Record<string, unknown> = {};
    this.OPTION(() => {
      const first = this.SUBRULE(this.actionCallArg);
      if (first) args[first.key] = first.value;
      this.MANY(() => {
        this.CONSUME(Comma);
        const next = this.SUBRULE2(this.actionCallArg);
        if (next) args[next.key] = next.value;
      });
    });
    this.CONSUME(RParen);
    return { action, args };
  });

  private actionCallArg = this.RULE(
    "actionCallArg",
    (): { key: string; value: unknown } => {
      const name = this.CONSUME(Identifier).image;
      this.CONSUME(Colon);
      const value = this.SUBRULE(this.term);
      return { key: name, value };
    },
  );

  // ──────── Effect list (semicolon-separated) ────────

  private effectList = this.RULE("effectList", (): Effect[] => {
    this.CONSUME(LBracket);
    const out: Effect[] = [];
    this.OPTION(() => {
      out.push(this.SUBRULE(this.effect));
      this.MANY(() => {
        this.CONSUME(Semi);
        out.push(this.SUBRULE2(this.effect));
      });
      this.OPTION2(() => this.CONSUME2(Semi)); // optional trailing semi
    });
    this.CONSUME(RBracket);
    return out;
  });

  private effect = this.RULE("effect", (): Effect => {
    return this.OR([
      {
        ALT: () => {
          this.CONSUME(Assert);
          const { relation, args } = this.SUBRULE(this.relationCallParts);
          return { type: "assert", relation, args } as Effect;
        },
      },
      {
        ALT: () => {
          this.CONSUME(Retract);
          const { relation, args } = this.SUBRULE2(this.relationCallParts);
          return { type: "retract", relation, args } as Effect;
        },
      },
      {
        // emit { key: term, … }
        GATE: () =>
          this.LA(1).tokenType === Identifier &&
          this.LA(1).image === "emit" &&
          this.LA(2).tokenType === LBrace,
        ALT: () => {
          this.CONSUME(Identifier); // 'emit'
          this.CONSUME(LBrace);
          const payload: Record<string, Term> = {};
          this.OPTION(() => {
            const first = this.SUBRULE(this.emitPayloadEntry);
            if (first) payload[first.key] = first.value;
            this.MANY(() => {
              this.CONSUME(Comma);
              const next = this.SUBRULE2(this.emitPayloadEntry);
              if (next) payload[next.key] = next.value;
            });
          });
          this.CONSUME(RBrace);
          return { type: "emit", payload } as Effect;
        },
      },
      {
        GATE: () => {
          if (this.LA(1).tokenType !== Identifier) return false;
          let i = 2;
          while (i <= 6 && this.LA(i).tokenType === Dot) i += 2;
          return this.LA(i).tokenType === Walrus;
        },
        ALT: () => {
          const target = this.SUBRULE(this.term);
          this.CONSUME(Walrus);
          const value = this.SUBRULE2(this.term);
          return { type: "fieldAssign", target, value } as Effect;
        },
      },
    ]);
  });

  private emitPayloadEntry = this.RULE(
    "emitPayloadEntry",
    (): { key: string; value: Term } => {
      const key = this.CONSUME(Identifier).image;
      this.CONSUME(Colon);
      const value = this.SUBRULE(this.term);
      return { key, value };
    },
  );

  // ──────── Per-def-kind body parsers (DSL v2) ────────

  /**
   * Trait body: `{ (FieldDecl | NestedDef) (";" (FieldDecl | NestedDef))* ";"? }`.
   * Each clause is either `name: type [= value]` (FieldDecl) or `def relation/action/rule …`.
   */
  private defTraitBody = this.RULE(
    "defTraitBody",
    (): Omit<TraitDefSpec, "id"> => {
      const out: { fields?: FieldDefSpec[]; relations?: RelationDefSpec[]; actions?: ActionDefSpec[]; rules?: RuleDefSpec[] } = {};
      this.CONSUME(LBrace);
      this.OPTION(() => {
        this.SUBRULE(this.traitBodyClause, { ARGS: [out] });
        this.MANY(() => {
          this.CONSUME(Semi);
          this.SUBRULE2(this.traitBodyClause, { ARGS: [out] });
        });
        this.OPTION2(() => this.CONSUME2(Semi));
      });
      this.CONSUME(RBrace);
      const ret: Omit<TraitDefSpec, "id"> = {};
      if (out.fields && out.fields.length > 0) ret.fields = out.fields;
      if (out.relations && out.relations.length > 0) ret.relations = out.relations;
      if (out.actions && out.actions.length > 0) ret.actions = out.actions;
      if (out.rules && out.rules.length > 0) ret.rules = out.rules;
      return ret;
    },
  );

  private traitBodyClause = this.RULE(
    "traitBodyClause",
    (out: {
      fields?: FieldDefSpec[];
      relations?: RelationDefSpec[];
      actions?: ActionDefSpec[];
      rules?: RuleDefSpec[];
    }): void => {
      this.OR([
        // Nested def: `def relation R(...) {...}` or action / rule
        {
          GATE: () => this.LA(1).tokenType === Def,
          ALT: () => {
            this.CONSUME(Def);
            const stmt = this.SUBRULE(this.defStmt);
            if (out && stmt && stmt.kind === "mutation") {
              const m = stmt.mutation;
              if (m.type === "defRelation") {
                (out.relations ??= []).push(m.spec);
              } else if (m.type === "defAction") {
                (out.actions ??= []).push(m.spec);
              } else if (m.type === "defRule") {
                (out.rules ??= []).push(m.spec);
              }
              // defTrait/defKind/defEntity inside a trait body are nonsensical;
              // post-parse validation will reject (for now we just drop them).
            }
          },
        },
        // Field decl: `id: typeRef [= value]`
        {
          ALT: () => {
            const fld = this.SUBRULE(this.fieldDecl);
            if (out && fld) (out.fields ??= []).push(fld);
          },
        },
      ]);
    },
  );

  private fieldDecl = this.RULE("fieldDecl", (): FieldDefSpec => {
    const id = this.CONSUME(Identifier).image;
    this.CONSUME(Colon);
    const type = this.SUBRULE(this.typeRef);
    let hasDefault = false;
    let defaultValue: unknown = undefined;
    this.OPTION(() => {
      this.CONSUME(Eq);
      defaultValue = this.SUBRULE(this.value);
      hasDefault = true;
    });
    const out: FieldDefSpec = { id, type };
    if (hasDefault) {
      out.default = defaultValue;
      out.hasDefault = true;
    }
    return out;
  });

  /**
   * Relation body: `{ (get: Expression | set: [EffectList])  (";" …)* ";"? }`.
   */
  private defRelationBody = this.RULE(
    "defRelationBody",
    (): Omit<RelationDefSpec, "id" | "parameters"> => {
      const out: { get?: Expression; setEffects?: Effect[] } = {};
      this.CONSUME(LBrace);
      this.OPTION(() => {
        this.SUBRULE(this.relationClause, { ARGS: [out] });
        this.MANY(() => {
          this.CONSUME(Semi);
          this.SUBRULE2(this.relationClause, { ARGS: [out] });
        });
        this.OPTION2(() => this.CONSUME2(Semi));
      });
      this.CONSUME(RBrace);
      const ret: Omit<RelationDefSpec, "id" | "parameters"> = {};
      if (out.get !== undefined) ret.get = out.get;
      if (out.setEffects !== undefined) ret.setEffects = out.setEffects;
      return ret;
    },
  );

  private relationClause = this.RULE(
    "relationClause",
    (out: { get?: Expression; setEffects?: Effect[] }): void => {
      const key = this.CONSUME(Identifier).image;
      this.CONSUME(Colon);
      if (key === "get") {
        const expr = this.SUBRULE(this.expression);
        if (out) out.get = expr;
      } else if (key === "set") {
        const effects = this.SUBRULE(this.effectList);
        if (out) out.setEffects = effects;
      } else {
        // Unknown clause; consume one value to keep the parser advancing.
        this.SUBRULE(this.value);
      }
    },
  );

  /**
   * Action body: `{ (requires: Expression | default: [EffectList]) (";" …)* ";"? }`.
   */
  private defActionBody = this.RULE(
    "defActionBody",
    (): Omit<ActionDefSpec, "id" | "parameters"> => {
      const out: { requires?: Expression; defaultEffects?: Effect[] } = {};
      this.CONSUME(LBrace);
      this.OPTION(() => {
        this.SUBRULE(this.actionClause, { ARGS: [out] });
        this.MANY(() => {
          this.CONSUME(Semi);
          this.SUBRULE2(this.actionClause, { ARGS: [out] });
        });
        this.OPTION2(() => this.CONSUME2(Semi));
      });
      this.CONSUME(RBrace);
      const ret: Omit<ActionDefSpec, "id" | "parameters"> = {};
      if (out.requires !== undefined) ret.requires = out.requires;
      if (out.defaultEffects !== undefined) ret.defaultEffects = out.defaultEffects;
      return ret;
    },
  );

  private actionClause = this.RULE(
    "actionClause",
    (out: { requires?: Expression; defaultEffects?: Effect[] }): void => {
      const key = this.CONSUME(Identifier).image;
      this.CONSUME(Colon);
      if (key === "requires") {
        const expr = this.SUBRULE(this.expression);
        if (out) out.requires = expr;
      } else if (key === "default") {
        const effects = this.SUBRULE(this.effectList);
        if (out) out.defaultEffects = effects;
      } else {
        this.SUBRULE(this.value);
      }
    },
  );

  /**
   * Rule body: typed clauses (phase / match / guard / effects / control / priority).
   */
  private defRuleBody = this.RULE(
    "defRuleBody",
    (): Omit<RuleDefSpec, "id" | "rulebook"> => {
      const out: Partial<Omit<RuleDefSpec, "id" | "rulebook">> = {};
      this.CONSUME(LBrace);
      this.OPTION(() => {
        this.SUBRULE(this.ruleClause, { ARGS: [out] });
        this.MANY(() => {
          this.CONSUME(Semi);
          this.SUBRULE2(this.ruleClause, { ARGS: [out] });
        });
        this.OPTION2(() => this.CONSUME2(Semi));
      });
      this.CONSUME(RBrace);
      // Validation deferred to post-parse to survive recording phase.
      return out as Omit<RuleDefSpec, "id" | "rulebook">;
    },
  );

  private ruleClause = this.RULE(
    "ruleClause",
    (out: Partial<Omit<RuleDefSpec, "id" | "rulebook">>): void => {
      const key = this.CONSUME(Identifier).image;
      this.CONSUME(Colon);
      if (key === "phase") {
        const phaseId = this.CONSUME2(Identifier).image as RuleDefSpec["phase"];
        if (out) out.phase = phaseId;
      } else if (key === "match") {
        const pattern = this.SUBRULE(this.actionCallValue);
        if (out) out.pattern = pattern;
      } else if (key === "guard") {
        const expr = this.SUBRULE(this.expression);
        if (out) out.guard = expr;
      } else if (key === "effects") {
        const effects = this.SUBRULE(this.effectList);
        if (out) out.effects = effects;
      } else if (key === "control") {
        const ctrl = this.CONSUME3(Identifier).image as RuleDefSpec["control"];
        if (out) out.control = ctrl;
      } else if (key === "priority") {
        const pri = Number(this.CONSUME(NumberLiteral).image);
        if (out) out.priority = pri;
      } else {
        this.SUBRULE(this.value);
      }
    },
  );

  /**
   * Kind body: optional `{ (Trait.field = value)  (";" …)* ";"? }`.
   * Empty body or no body both allowed.
   */
  private defKindBody = this.RULE(
    "defKindBody",
    (): { fields?: Record<string, Record<string, unknown>> } => {
      const out: { fields?: Record<string, Record<string, unknown>> } = {};
      this.OPTION(() => {
        this.CONSUME(LBrace);
        this.OPTION2(() => {
          this.SUBRULE(this.kindFieldOverride, { ARGS: [out] });
          this.MANY(() => {
            this.CONSUME(Semi);
            this.SUBRULE2(this.kindFieldOverride, { ARGS: [out] });
          });
          this.OPTION3(() => this.CONSUME2(Semi));
        });
        this.CONSUME(RBrace);
      });
      return out;
    },
  );

  private kindFieldOverride = this.RULE(
    "kindFieldOverride",
    (out: { fields?: Record<string, Record<string, unknown>> }): void => {
      const traitId = this.CONSUME(Identifier).image;
      this.CONSUME(Dot);
      const fieldId = this.CONSUME2(Identifier).image;
      this.CONSUME(Eq);
      const v = this.SUBRULE(this.value);
      if (out) {
        out.fields ??= {};
        out.fields[traitId] ??= {};
        out.fields[traitId][fieldId] = v;
      }
    },
  );

  /**
   * Entity body: optional `{ EntityClause (";" EntityClause)* ";"? }`.
   * EntityClause is one of:
   *   - `Trait.field = value;` (qualified field override)
   *   - `field = value;` (auto-resolved field override)
   *   - `trait Foo (";" | "{" overrides "}" ";")` (trait grant)
   *   - `metadata.key = value;`
   */
  private defEntityBody = this.RULE(
    "defEntityBody",
    (): {
      traits?: TraitGrantSpec[];
      fields?: Record<string, Record<string, unknown>>;
      metadata?: Record<string, unknown>;
    } => {
      const out: {
        traits?: TraitGrantSpec[];
        fields?: Record<string, Record<string, unknown>>;
        metadata?: Record<string, unknown>;
      } = {};
      this.OPTION(() => {
        this.CONSUME(LBrace);
        this.OPTION2(() => {
          this.SUBRULE(this.entityClause, { ARGS: [out] });
          this.MANY(() => {
            this.CONSUME(Semi);
            this.SUBRULE2(this.entityClause, { ARGS: [out] });
          });
          this.OPTION3(() => this.CONSUME2(Semi));
        });
        this.CONSUME(RBrace);
      });
      return out;
    },
  );

  private entityClause = this.RULE(
    "entityClause",
    (out: {
      traits?: TraitGrantSpec[];
      fields?: Record<string, Record<string, unknown>>;
      metadata?: Record<string, unknown>;
    }): void => {
      this.OR([
        // `trait Foo` (with optional `{ overrides }`)
        {
          GATE: () => this.LA(1).tokenType === Identifier && this.LA(1).image === "trait",
          ALT: () => {
            this.CONSUME(Identifier); // 'trait'
            const traitId = this.CONSUME2(Identifier).image;
            const grant: TraitGrantSpec = { id: traitId };
            this.OPTION(() => {
              this.CONSUME(LBrace);
              const fields: Record<string, unknown> = {};
              this.OPTION2(() => {
                this.SUBRULE(this.traitGrantOverride, { ARGS: [fields] });
                this.MANY(() => {
                  this.CONSUME(Semi);
                  this.SUBRULE2(this.traitGrantOverride, { ARGS: [fields] });
                });
                this.OPTION3(() => this.CONSUME2(Semi));
              });
              this.CONSUME(RBrace);
              if (Object.keys(fields).length > 0) grant.fields = fields;
            });
            if (out) {
              (out.traits ??= []).push(grant);
            }
          },
        },
        // `metadata.key = value`
        {
          GATE: () =>
            this.LA(1).tokenType === Identifier &&
            this.LA(1).image === "metadata" &&
            this.LA(2).tokenType === Dot,
          ALT: () => {
            this.CONSUME3(Identifier); // 'metadata'
            this.CONSUME2(Dot);
            const key = this.CONSUME4(Identifier).image;
            this.CONSUME2(Eq);
            const v = this.SUBRULE(this.value);
            if (out) {
              out.metadata ??= {};
              out.metadata[key] = v;
            }
          },
        },
        // `Trait.field = value` (qualified override) — disambiguated by `Dot` after first Identifier
        {
          GATE: () =>
            this.LA(1).tokenType === Identifier &&
            this.LA(2).tokenType === Dot &&
            this.LA(3).tokenType === Identifier &&
            this.LA(4).tokenType === Eq,
          ALT: () => {
            const traitId = this.CONSUME5(Identifier).image;
            this.CONSUME3(Dot);
            const fieldId = this.CONSUME6(Identifier).image;
            this.CONSUME3(Eq);
            const v = this.SUBRULE2(this.value);
            if (out) {
              out.fields ??= {};
              out.fields[traitId] ??= {};
              out.fields[traitId][fieldId] = v;
            }
          },
        },
        // `field = value` (auto-resolved override) — store under wildcard "*"
        {
          ALT: () => {
            const fieldId = this.CONSUME7(Identifier).image;
            this.CONSUME4(Eq);
            const v = this.SUBRULE3(this.value);
            if (out) {
              out.fields ??= {};
              out.fields["*"] ??= {};
              out.fields["*"][fieldId] = v;
            }
          },
        },
      ]);
    },
  );

  private traitGrantOverride = this.RULE(
    "traitGrantOverride",
    (fields: Record<string, unknown>): void => {
      const id = this.CONSUME(Identifier).image;
      this.CONSUME(Eq);
      const v = this.SUBRULE(this.value);
      if (fields) fields[id] = v;
    },
  );
}

/**
 * Post-parse semantic validation for mutation statements. Lets the parser stay
 * dumb (and recording-phase-safe) while still surfacing clean errors for
 * things like unknown undef target kinds, missing rule.match, etc.
 */
function validateMutationSpec(stmt: Statement): void {
  if (stmt.kind !== "mutation") return;
  const m = stmt.mutation;
  switch (m.type) {
    case "undef": {
      if (!isUndefTargetKind(m.targetKind)) {
        throw new ParseError(`unknown undef target kind '${m.targetKind}'`);
      }
      return;
    }
    case "defRelation":
      // No relation-spec validation needed post-parse; `get` is opaque, `setEffects`
      // already typed by the parser path.
      return;
    case "defRule": {
      const phase = m.spec.phase as unknown;
      if (phase !== "before" && phase !== "during" && phase !== "after" && phase !== "instead") {
        throw new ParseError(
          `rule.phase must be before|during|after|instead (got '${String(phase)}')`,
        );
      }
      const match = m.spec.pattern as unknown;
      if (
        typeof match !== "object" ||
        match === null ||
        typeof (match as ActionPatternSpec).action !== "string"
      ) {
        throw new ParseError("rule.match must be an action call (e.g. `Move(actor: x)`)");
      }
      const c = m.spec.control as unknown;
      if (c !== undefined && c !== "continue" && c !== "stop") {
        throw new ParseError(`rule.control must be continue|stop (got '${String(c)}')`);
      }
      const pri = m.spec.priority as unknown;
      if (pri !== undefined && typeof pri !== "number") {
        throw new ParseError("rule.priority must be a number");
      }
      return;
    }
    default:
      return;
  }
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
  const stmt = ast as Statement;
  validateMutationSpec(stmt);
  return stmt;
}

/**
 * Parse a query, accepting:
 *   - explicit `query { x | … }` form (DSL v2)
 *   - bare comprehension `{ x | … }` (legacy convenience: auto-wrapped with `query`)
 *   - bare `?- expression` (legacy yes/no shorthand: auto-converted to `exists { … }`,
 *     returned as a `Query` with empty head)
 */
export function parseQuery(input: string): Query {
  const trimmed = input.trimStart();
  let stmt: Statement;
  if (trimmed.startsWith("{")) {
    stmt = parseStatement(`query ${trimmed}`);
  } else if (trimmed.startsWith("?-")) {
    const body = trimmed.slice(2);
    stmt = parseStatement(`exists { ${body} }`);
  } else {
    stmt = parseStatement(trimmed);
  }
  if (stmt.kind === "query") return stmt.query;
  if (stmt.kind === "exists") return { head: [], body: stmt.body };
  throw new ParseError(`expected a query, got ${stmt.kind}`);
}

export function parseNamedPredicate(input: string): NamedPredicate {
  const stmt = parseStatement(input);
  if (stmt.kind !== "named_predicate") {
    throw new ParseError(`expected a named predicate, got ${stmt.kind}`);
  }
  return stmt.predicate;
}

/**
 * Parse a bare expression. Wraps as `exists { … }` so the parser sees a
 * statement and we extract the body. Convenient for tests.
 */
export function parseExpression(input: string): Expression {
  const stmt = parseStatement(`exists { ${input} }`);
  if (stmt.kind !== "exists") throw new ParseError("expected exists statement");
  return stmt.body;
}

/**
 * Parse a sequence of statements. Two boundaries are recognized:
 *   - top-level `;` — required after body-less statements (def kind X: T1;,
 *     undef trait Foo;, query …;, exists …;, show …;, assert/retract/:= top-level)
 *   - top-level `}` — closes a body-bearing def; the next statement starts after it
 *
 * Depth tracking ignores `;` and `}` inside nested braces/brackets/parens.
 * `#` line comments and string literals are skipped.
 */
export function parseStatements(input: string): Statement[] {
  const chunks: string[] = [];
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  let buf = "";
  const flush = (): void => {
    const piece = buf.trim();
    if (piece.length > 0) chunks.push(piece);
    buf = "";
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      buf += ch;
      continue;
    }
    if (inString) {
      buf += ch;
      if (ch === "\\" && i + 1 < input.length) {
        buf += input[i + 1];
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === "#") {
      inLineComment = true;
      buf += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      buf += ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      buf += ch;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      buf += ch;
      // After closing a top-level `}`, the body-bearing statement is complete.
      // The trailing `;` (if any) is optional and consumed by the `;` branch
      // below; otherwise we flush here when the next non-whitespace looks like
      // the start of a new statement.
      if (depth === 0 && ch === "}") {
        // Look ahead past whitespace and `#` line comments for the next
        // non-trivial char. If it's `;`, leave the chunk open (the `;`
        // branch will flush). Otherwise flush now.
        let j = i + 1;
        let inTrailingComment = false;
        while (j < input.length) {
          const nc = input[j]!;
          if (inTrailingComment) {
            if (nc === "\n") inTrailingComment = false;
            j++;
            continue;
          }
          if (nc === " " || nc === "\t" || nc === "\n" || nc === "\r") {
            j++;
            continue;
          }
          if (nc === "#") {
            inTrailingComment = true;
            j++;
            continue;
          }
          break;
        }
        if (j >= input.length || input[j] !== ";") {
          flush();
        }
      }
      continue;
    }
    if (ch === ";" && depth === 0) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return chunks.map(parseStatement);
}

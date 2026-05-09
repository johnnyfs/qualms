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
  TraitAttachmentSpec,
  TraitDefSpec,
  TraitFilter,
  UndefTargetKind,
  Value,
} from "./ast.js";
import { isUndefTargetKind } from "./ast.js";
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
// Mutation-statement keywords
const Def = keyword("Def", "def");
const Undef = keyword("Undef", "undef");
const Assert = keyword("Assert", "assert");
const Retract = keyword("Retract", "retract");
const In = keyword("In", "in");

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
];

const QualmsLexer = new Lexer(allTokens);

// ──────── Parser (embedded actions: build the AST directly) ────────

export type Statement =
  | { kind: "query"; query: Query }
  | { kind: "named_predicate"; predicate: NamedPredicate }
  | { kind: "mutation"; mutation: MutationStatement };

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
    super(allTokens, { recoveryEnabled: false, maxLookahead: 5 });
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
          const kindTok = this.CONSUME3(Identifier).image;
          const name = this.CONSUME4(Identifier).image;
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
          // Look ahead for `:=` within the next few tokens, only if the leading
          // tokens look like a term-led path (Identifier with optional `.` chain).
          if (this.LA(1).tokenType !== Identifier) return false;
          let i = 2;
          while (i <= 6 && this.LA(i).tokenType === Dot) {
            // Skip the dot and the following identifier.
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
            parameters.push(this.CONSUME5(Identifier).image);
            this.MANY(() => {
              this.CONSUME(Comma);
              parameters.push(this.CONSUME6(Identifier).image);
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
    const body = this.SUBRULE(this.defActionBody);
    return {
      kind: "mutation",
      mutation: { type: "defAction", spec: { id, parameters, ...body } },
    };
  });

  private defKindStmt = this.RULE("defKindStmt", (): Statement => {
    this.CONSUME(Identifier); // 'kind'
    const id = this.CONSUME2(Identifier).image;
    const body = this.SUBRULE(this.defKindBody);
    return {
      kind: "mutation",
      mutation: { type: "defKind", spec: { id, ...body } },
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
    this.SUBRULE(this.defEmptyBody); // accepts `{}`
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

  /** `( id (: type)? , ... )` — used by relation/action parameter lists. */
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
      type = this.CONSUME2(Identifier).image;
    });
    return type !== undefined ? { id, type } : { id };
  });

  /** `{}` — used by def rulebook (empty body). */
  private defEmptyBody = this.RULE("defEmptyBody", (): void => {
    this.CONSUME(LBrace);
    this.CONSUME(RBrace);
  });

  /**
   * Generic def-body parser: `{ key: value, key: value, ... }`. Returns a record
   * of clauses; each consumer extracts the keys it cares about.
   */
  private defBody = this.RULE("defBody", (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    this.CONSUME(LBrace);
    this.OPTION(() => {
      const first = this.SUBRULE(this.defClause);
      if (first) out[first.key] = first.value;
      this.MANY(() => {
        this.CONSUME(Comma);
        const next = this.SUBRULE2(this.defClause);
        if (next) out[next.key] = next.value;
      });
    });
    this.CONSUME(RBrace);
    return out;
  });

  private defClause = this.RULE(
    "defClause",
    (): { key: string; value: unknown } => {
      const key = this.CONSUME(Identifier).image;
      this.CONSUME(Colon);
      const value = this.SUBRULE(this.clauseValue);
      return { key, value };
    },
  );

  /**
   * Clause value: predicate (?- expr), effect list, action call (for rule.match),
   * or a JSON-like value (scalar / identifier / object / array).
   */
  private clauseValue = this.RULE("clauseValue", (): unknown => {
    return this.OR([
      // Predicate: ?- expression  (used for guard, requires, get)
      {
        GATE: () => this.LA(1).tokenType === QueryQ,
        ALT: () => {
          this.CONSUME(QueryQ);
          return this.SUBRULE(this.expression);
        },
      },
      // Effect list: [ effect, effect, ... ]   (used for effects, set, default)
      // We GATE on the first element looking like an effect statement (Assert/Retract/Identifier-with-Walrus-shape).
      {
        GATE: () => {
          if (this.LA(1).tokenType !== LBracket) return false;
          const t2 = this.LA(2).tokenType;
          if (t2 === Assert || t2 === Retract) return true;
          // Field-assign effect: Identifier (Dot Identifier)+ Walrus
          if (t2 !== Identifier) return false;
          let i = 3;
          while (i <= 7 && this.LA(i).tokenType === Dot) i += 2;
          return this.LA(i).tokenType === Walrus;
        },
        ALT: () => this.SUBRULE(this.effectList),
      },
      // Action-call value: Identifier `(` argName `:` value, ... `)`  (used for rule.match)
      {
        GATE: () =>
          this.LA(1).tokenType === Identifier &&
          this.LA(2).tokenType === LParen &&
          // distinguish from a generic ident-followed-by-paren by looking inside
          // for `name :` (keyword-arg) — bare `(` `)` is also ok.
          (this.LA(3).tokenType === RParen ||
            (this.LA(3).tokenType === Identifier && this.LA(4).tokenType === Colon)),
        ALT: () => this.SUBRULE(this.actionCallValue),
      },
      { ALT: () => this.SUBRULE(this.jsonValue) },
    ]);
  });

  /**
   * JSON-like value used inside def bodies: scalars (string/number/bool),
   * identifiers (treated as strings — for trait/kind/relation refs and named
   * options like `current`), object literals, array literals.
   */
  private jsonValue = this.RULE("jsonValue", (): unknown => {
    return this.OR([
      {
        ALT: () => unquoteString(this.CONSUME(StringLiteral)),
      },
      {
        ALT: () => Number(this.CONSUME(NumberLiteral).image),
      },
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
      { ALT: () => this.SUBRULE(this.jsonObject) },
      { ALT: () => this.SUBRULE(this.jsonArray) },
      // Bare identifier — treated as a string. Lets `traits: [Presentable, Container]`
      // and other identifier-valued options work without quoting.
      {
        ALT: () => this.CONSUME(Identifier).image,
      },
    ]);
  });

  private jsonObject = this.RULE("jsonObject", (): Record<string, unknown> => {
    this.CONSUME(LBrace);
    const out: Record<string, unknown> = {};
    this.OPTION(() => {
      const first = this.SUBRULE(this.jsonObjectEntry);
      if (first) out[first.key] = first.value;
      this.MANY(() => {
        this.CONSUME(Comma);
        const next = this.SUBRULE2(this.jsonObjectEntry);
        if (next) out[next.key] = next.value;
      });
    });
    this.CONSUME(RBrace);
    return out;
  });

  private jsonObjectEntry = this.RULE(
    "jsonObjectEntry",
    (): { key: string; value: unknown } => {
      const key = this.OR([
        { ALT: () => unquoteString(this.CONSUME(StringLiteral)) },
        { ALT: () => this.CONSUME(Identifier).image },
      ]);
      this.CONSUME(Colon);
      const value = this.SUBRULE(this.jsonValue);
      return { key, value };
    },
  );

  private jsonArray = this.RULE("jsonArray", (): unknown[] => {
    this.CONSUME(LBracket);
    const out: unknown[] = [];
    this.OPTION(() => {
      out.push(this.SUBRULE(this.jsonValue));
      this.MANY(() => {
        this.CONSUME(Comma);
        out.push(this.SUBRULE2(this.jsonValue));
      });
    });
    this.CONSUME(RBracket);
    return out;
  });

  /** Action-pattern call: `Move(actor: x, target: y)`. Args are Term-typed. */
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

  /** `[ effect, effect, ... ]` */
  private effectList = this.RULE("effectList", (): Effect[] => {
    this.CONSUME(LBracket);
    const out: Effect[] = [];
    this.OPTION(() => {
      out.push(this.SUBRULE(this.effect));
      this.MANY(() => {
        this.CONSUME(Comma);
        out.push(this.SUBRULE2(this.effect));
      });
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
      // Field-assign effect: term := term
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

  // ──────── Per-def-kind body wrappers ────────

  private defTraitBody = this.RULE(
    "defTraitBody",
    (): Omit<TraitDefSpec, "id"> => {
      const clauses = this.SUBRULE(this.defBody);
      const out: Omit<TraitDefSpec, "id"> = {};
      if (clauses["fields"] !== undefined) out.fields = toFieldList(clauses["fields"], "fields");
      if (clauses["parameters"] !== undefined) out.parameters = toParamList(clauses["parameters"], "parameters");
      // Note: relations/actions/rules nested inside trait bodies parse into the
      // generic record shape; the executor (or future grammar refinement) can
      // expand them. For now only fields/parameters are supported on traits.
      return out;
    },
  );

  private defRelationBody = this.RULE(
    "defRelationBody",
    (): Omit<RelationDefSpec, "id" | "parameters"> => {
      const clauses = this.SUBRULE(this.defBody);
      const out: Omit<RelationDefSpec, "id" | "parameters"> = {};
      if (clauses["get"] !== undefined) out.get = clauses["get"] as Expression;
      if (clauses["set"] !== undefined) out.setEffects = clauses["set"] as Effect[];
      return out;
    },
  );

  private defActionBody = this.RULE(
    "defActionBody",
    (): Omit<ActionDefSpec, "id" | "parameters"> => {
      const clauses = this.SUBRULE(this.defBody);
      const out: Omit<ActionDefSpec, "id" | "parameters"> = {};
      if (clauses["requires"] !== undefined) out.requires = clauses["requires"] as Expression;
      if (clauses["default"] !== undefined) out.defaultEffects = clauses["default"] as Effect[];
      return out;
    },
  );

  private defKindBody = this.RULE(
    "defKindBody",
    (): Omit<KindDefSpec, "id"> => {
      const clauses = this.SUBRULE(this.defBody);
      const traits: TraitAttachmentSpec[] = clauses["traits"]
        ? toAttachmentList(clauses["traits"])
        : [];
      const out: Omit<KindDefSpec, "id"> = { traits };
      if (clauses["fields"] !== undefined) {
        out.fields = clauses["fields"] as Record<string, Record<string, unknown>>;
      }
      return out;
    },
  );

  private defRuleBody = this.RULE(
    "defRuleBody",
    (): Omit<RuleDefSpec, "id" | "rulebook"> => {
      const clauses = this.SUBRULE(this.defBody);
      // Validation deferred to post-parse to survive Chevrotain's recording phase.
      const out = {
        phase: clauses["phase"] as RuleDefSpec["phase"],
        pattern: clauses["match"] as ActionPatternSpec,
      } as Omit<RuleDefSpec, "id" | "rulebook">;
      if (clauses["guard"] !== undefined) out.guard = clauses["guard"] as Expression;
      if (clauses["effects"] !== undefined) out.effects = clauses["effects"] as Effect[];
      if (clauses["control"] !== undefined) out.control = clauses["control"] as RuleDefSpec["control"];
      if (clauses["priority"] !== undefined) out.priority = clauses["priority"] as number;
      return out;
    },
  );

  private defEntityBody = this.RULE(
    "defEntityBody",
    (): Omit<EntityDefSpec, "id" | "kind"> => {
      const clauses = this.SUBRULE(this.defBody);
      const out: Omit<EntityDefSpec, "id" | "kind"> = {};
      if (clauses["traits"] !== undefined) out.traits = toAttachmentList(clauses["traits"]);
      if (clauses["fields"] !== undefined) {
        out.fields = clauses["fields"] as Record<string, Record<string, unknown>>;
      }
      if (clauses["metadata"] !== undefined) {
        out.metadata = clauses["metadata"] as Record<string, unknown>;
      }
      return out;
    },
  );
}

// ──────── Helpers for clause-shape conversion ────────
//
// These helpers run inside parser actions which Chevrotain executes both during
// the grammar-recording phase (with placeholder tokens) and during real parsing.
// They tolerate non-conforming inputs by short-circuiting; semantic validation
// of the resulting AST runs in `validateMutationSpec` after parsing completes.

function toFieldList(value: unknown, _label: string): FieldDefSpec[] {
  if (Array.isArray(value)) {
    return value
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      .map((entry) => entryToFieldSpec(typeof entry["id"] === "string" ? entry["id"] : "?", entry));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).map(([id, entry]) =>
      typeof entry === "object" && entry !== null
        ? entryToFieldSpec(id, entry as Record<string, unknown>)
        : ({ id } as FieldDefSpec),
    );
  }
  return [];
}

function entryToFieldSpec(id: string, entry: Record<string, unknown>): FieldDefSpec {
  const out: FieldDefSpec = { id };
  if (typeof entry["type"] === "string") out.type = entry["type"];
  if (Object.prototype.hasOwnProperty.call(entry, "default")) {
    out.default = entry["default"];
    out.hasDefault = true;
  }
  return out;
}

function toParamList(value: unknown, label: string): ParameterDefSpec[] {
  return toFieldList(value, label) as ParameterDefSpec[];
}

function toAttachmentList(value: unknown): TraitAttachmentSpec[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry): TraitAttachmentSpec | null => {
      if (typeof entry === "string") return { id: entry };
      if (typeof entry === "object" && entry !== null) {
        const e = entry as Record<string, unknown>;
        if (typeof e["id"] !== "string") return null;
        const out: TraitAttachmentSpec = { id: e["id"] };
        if (e["parameters"] !== undefined) {
          out.parameters = e["parameters"] as Record<string, unknown>;
        }
        if (e["fields"] !== undefined) {
          out.fields = e["fields"] as Record<string, unknown>;
        }
        return out;
      }
      return null;
    })
    .filter((e): e is TraitAttachmentSpec => e !== null);
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

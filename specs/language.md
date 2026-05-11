# Qualms DSL — Formal Specification

This document specifies the surface syntax and semantics of the Qualms
story DSL as implemented in `qualms/src/language/` (parser, model, runtime,
emitter). It is intended as a reimplementation contract for the current
engine surface, not as a TypeScript-specific design note.

---

## 1. Source Files

A Qualms source file is UTF-8 text holding a single `Program`. Files
conventionally use the extension `.qualms`.

### 1.1 Lexical structure

The lexer produces the following token classes:

| Token       | Form                                                |
| ----------- | --------------------------------------------------- |
| identifier  | `[A-Za-z_][A-Za-z0-9_]*`                            |
| number      | `[0-9][0-9.]*` (parsed via JavaScript `Number`)     |
| string      | `"..."`; backslash escapes the following character  |
| punctuation | `(` `)` `{` `}` `,` `:` `;` `!` `?` `&` \|`         |
| operator    | `==` `=>`                                           |
| eof         | implicit end-of-input sentinel                      |

Whitespace (space, tab, CR, LF) is insignificant. A line comment starts with
`--` and runs to the next newline. There are no block comments and no
preprocessor directives.

The single-character symbol `_` is lexed as an identifier and recognised
contextually as the wildcard token in parameter and term positions.

### 1.2 Reserved keywords (contextual)

Keywords are not lexically distinguished from identifiers; the parser
matches them by image at fixed grammatical positions. Authors should avoid
using these names for traits, relations, predicates, actions, or entities:

```
action  after   assert  before  bindings emit   entity  extend
extern  fact    fail    failed  not      one    passed  play
predicate       query   reasons relation replace set     succeed
trait   unique  validation
when    _
```

The identifier `Any` is not a keyword; it is a reserved trait/type name
recognised by the runtime type checker (§ 5.4).

---

## 2. Grammar

The grammar is given in EBNF. `<id>` denotes an identifier token, `<num>`
a number token, `<str>` a string token. Terminal keywords are written
literally.

```ebnf
Program        ::= { TopLevel }
TopLevel       ::= TraitDecl
                 | RelationDecl
                 | ExternPredicateDecl
                 | CallableDecl
                 | RuleDecl
                 | EntityDecl
                 | ExtendDecl
                 | SetStatement
                 | ValidationDecl

TraitDecl      ::= "trait" <id>
RelationDecl   ::= "relation" <id> "(" [ RelationParam { "," RelationParam } ] ")"
                   [ "unique" "(" <id> { "," <id> } ")" ]
RelationParam  ::= [ <id> ":" ] [ "one" ] TypeExpr

ExternPredicateDecl
               ::= "extern" "predicate" <id> ParamList [ ";" ]

CallableDecl   ::= [ "replace" ] ( "action" | "predicate" ) <id> ParamList Block
RuleDecl       ::= ( "before" | "after" ) <id> ParamList Block

EntityDecl     ::= "entity" <id> TraitSet
ExtendDecl     ::= "extend" <id> TraitSet
TraitSet       ::= "{" [ <id> { "," <id> } ] "}"

ParamList      ::= "(" [ Param { "," Param } ] ")"
Param          ::= ( "_" | <id> ) [ ":" TypeExpr ] [ "{" [ Expr { ";" Expr } [";"] ] "}" ]

TypeExpr       ::= <id>
                 | "(" TypeExpr { "&" TypeExpr } ")"

Block          ::= "{" { BodyStmt [ ";" ] } "}"
BodyStmt       ::= WhenStmt
                 | SetStatement
                 | EmitStatement
                 | "succeed" [ ";" ]
                 | "fail" [ ";" ]

WhenStmt       ::= "when" "(" Expr ")" Block

SetStatement   ::= "set" SetEffect
                 | "set" "{" { SetEffect [ ";" ] } "}"
SetEffect      ::= [ "!" ] RelationAtom
EmitStatement  ::= "emit" RelationAtom [ ";" ]

ValidationDecl ::= "validation" <id> "{"
                   { ValidationAssertion [ ";" ] }
                   "}"
ValidationAssertion
               ::= "assert" [ "not" ] "fact" RelationAtom
                 | "assert" [ "not" ] "query" Expr
                   [ "=>" "bindings" "{" { Equality [ ";" ] } "}" ]
                 | "assert" "play" RelationAtom "=>" ( "passed" | "failed" )
                   [ "effects" "{" { SetEffect [ ";" ] } "}" ]
                   [ "reasons" "{" { Expr [ ";" ] } "}" ]

RelationAtom   ::= <id> "(" [ Term { "," Term } ] ")"

Term           ::= <str>
                 | <num>
                 | "_"
                 | "?" <id>
                 | <id>
                 | <id> "(" [ Term { "," Term } ] ")"  -- relation instance

Expr           ::= OrExpr
OrExpr         ::= AndExpr  { "|" AndExpr }
AndExpr        ::= UnaryExpr { "&" UnaryExpr }
UnaryExpr      ::= "!" UnaryExpr
                 | Primary
Primary        ::= "(" Expr ")"
                 | Term [ "==" Term ]
Equality       ::= Term "==" Term
```

Notes:

- `;` is permitted but never required between top-level statements; it is
  consumed as a separator.
- Set effects use `;` as an internal separator inside the block form. A
  single-effect `set` permits an optional trailing `;`.
- In `Primary`, a bare `Term` is only legal as an expression if it is a
  relation instance (`<id> "(" ... ")"`) or if it is the left operand of
  `==`. Otherwise the parser raises a `LanguageParseError`.

### 2.1 Operator precedence

Highest binding first; all operators are left-associative.

1. unary `!`
2. `&`
3. `|`

Equality `==` is not part of the binary expression grammar; it appears only
at `Primary` level between two `Term`s. Therefore `a == b & c == d` parses as
`(a == b) & (c == d)`, while `!a == b` is a parse error (the `!` would bind
to a term, but `Term` does not accept a leading `!`).

---

## 3. Declarations

### 3.1 `trait`

```
trait Locatable
```

Introduces a nominal trait identifier. Traits carry no fields, no rules, and
no associated relations. They exist to be referenced by entity declarations
and by type expressions in parameter patterns.

Duplicate trait identifiers raise `LanguageModelError("duplicate trait '…'")`.

### 3.2 `relation`

```
relation At(subject: Locatable, location: Location) unique(subject)
relation Path(Location, Location)
relation Gated(path: Path, door: Openable) unique(path)
```

Declares a relation symbol together with a fixed parameter arity and per-
parameter type expressions. Relation parameters may be named with
`name: Type`, which is required when the relation uses an explicit
`unique(...)` constraint (§ 4.3). A legacy parameter prefixed with `one` is
also a cardinality constraint (§ 4.3). The parameter type may name a trait,
another relation symbol, an entity literal in parameter-slot sugar, or `Any`.

Relations are the only mechanism for storing world state. Authors do not
declare fields on entities.

Duplicate relation identifiers raise `LanguageModelError`.

### 3.3 `extern predicate`

```
extern predicate CanSee(actor: Actor, target: Locatable);
```

Declares a pure host-supplied predicate. External predicates have typed
parameters but no DSL body and no rules. They may be called from expressions
only when every argument is ground after environment resolution. The host
adapter must return a deterministic boolean for the current simulation tick
and must not mutate the story model or host simulation.

### 3.4 `predicate` and `action`

```
predicate IsColocated(actor: (Actor & Locatable) { At(actor, ?here) }, target: Locatable) {
  when (At(target, ?here)) { succeed; }
}

action Go(actor: (Actor & Locatable) { At(actor, ?here) }, target: Location) {
  when (Path(?here, target)) { set At(actor, target) }
}
```

Callable declarations attach a parameter list and a body block to a name.
Actions are external entry points playable through the MCP `play` tool;
predicates are internal helpers callable from `when` clauses (§ 5.5).

Both kinds share parameter pattern syntax (§ 4) and block body grammar (§ 5).
The runtime distinguishes them by whether `after` rules fire (§ 5.3.4).
Predicates are pure: a predicate body cannot contain `set` or `emit`, and a
rule attached to a predicate cannot contain `set` or `emit`.

By default, redeclaring a callable raises `LanguageModelError`. Prefixing
the declaration with `replace` overrides the prior definition in place:

```
replace action Examine(actor: Actor, target) {
  when (IsVisibleTo(actor, target)) { succeed; }
}
```

`replace` requires that a prior definition exist; otherwise the model
raises `LanguageModelError("replace … '…' has no prior definition")`.

### 3.5 `before` and `after` rules

```
before Go(actor: (Actor & Locatable) { At(actor, ?here) },
          target: Location { Gated(Path(?here, target), ?door) }) {
  when (!Opened(?door)) { fail; }
}

after Take(_, target: Locatable { At(target, ?here) }) {
  set { !At(target, ?here); }
}
```

A rule attaches an out-of-band body to an existing action or predicate by
name. Rules are stored in order of declaration; the runtime evaluates all
matching rules of the requested phase against the same arguments and
parameter patterns (§ 5.3).

The grammar does not require the rule's parameter list to mirror the
callable's parameter list one-for-one in name or type — only that the arity
matches. Wildcards and renames are common.

Rules must target an existing callable. `after` rules may target actions only;
`before` rules may target actions or predicates.

### 3.6 `entity` and `extend`

```
entity Cell { Location }
entity Player { Actor, Locatable }
extend Bars { Openable, Lockable }
```

`entity` introduces an entity identifier together with an initial set of
traits. Every trait listed must already be declared.

`extend` adds traits to a previously declared entity. The entity must
already exist; unknown traits raise `LanguageModelError`.

Entities are global, immutable identifiers — they cannot be retracted, and
their trait set is monotonically additive once declared.

### 3.7 `set` (top-level)

```
set { At(Player, Cell); Path(Cell, Corridor); }
set !At(Bars, Cell);
```

At the top level, `set` performs immediate assertions and retractions
against the world-state fact base. Inside a callable body, `set` is also a
body statement (§ 5.2).

The single-effect form `set RelationAtom` and the block form
`set { effect; effect; … }` are equivalent. A leading `!` retracts; absence
asserts.

All identifiers inside a top-level `set` must be ground (entity ids or
literals). Wildcards and free variables are not legal here.

### 3.8 `validation`

```
validation TutorialSmoke {
  assert fact At(Player, Cell);
  assert query At(Player, ?where) => bindings { ?where == Cell; };
  assert play Go(Player, Outside) => failed reasons { !Path(Cell, Outside); };
}
```

Validation declarations define regression checks that can be run before
committing authored mutations. They are part of the model but do not execute
during load. A validation assertion may require a fact to be present or absent,
an expression query to match or not match, or an action call to pass or fail.

Validation `query` and `play` assertions are pure with respect to the live
model. `play` validations run against a candidate clone and discard all effects.
Query binding assertions require exactly one result row matching the listed
equalities. Play effect assertions require the exact committed effect list in
order. Play reason assertions require the listed reasons to be present.

---

## 4. Parameter Patterns

A parameter pattern declares how the runtime should bind an argument to a
local name and what additional constraints the argument must satisfy.

```
Param ::= ( "_" | <id> ) [ ":" TypeExpr ] [ "{" Expr { ";" Expr } "}" ]
```

### 4.1 Names and wildcards

- A parameter beginning with `_` is a wildcard: the argument is accepted
  without binding a name. A wildcard may still carry a type and constraints.
- Any other identifier introduces a binding. Within the body and within
  later parameter patterns, that identifier refers to the bound ground term.
- Re-binding an already-bound identifier to a different value rejects the
  match (no shadowing). Re-binding to the same value is a no-op.

### 4.2 Type expressions

A type expression is one of:

- a named identifier — interpreted as a trait, a relation symbol, or `Any`
  (§ 5.4);
- a parenthesised intersection `(T1 & T2 & …)` — the argument must satisfy
  every constituent type.

The grammar does not permit an unparenthesised top-level intersection in a
parameter type; intersections must be enclosed.

A relation-typed parameter accepts only ground relation terms whose
relation symbol matches exactly. It does not infer that the argument
"happens to" satisfy a relation predicate.

### 4.3 Cardinality and uniqueness on relations

`relation R(key: A, value: B) unique(key)` declares that each `key` may be
associated with at most one `value`. Asserting `R(a, b1)` retracts any
pre-existing `R(a, *)` fact (§ 6.3). Multiple names inside `unique(...)`
form a composite uniqueness key.

The legacy form `relation R(A, one B)` remains accepted. It declares the
same functional dependency indirectly: all non-`one` parameters form the
uniqueness key.

Cardinality applies only to relation parameters, not callable parameters.

### 4.4 Constraints

A parameter's optional `{ … }` block holds zero or more constraint
expressions separated by `;`. Constraints are evaluated as expressions (§ 5.6)
against the environment built up from prior parameter bindings.

Constraints serve two purposes:

1. **Filter** — a constraint that fails to match rejects the binding.
2. **Bind further names** — a constraint that succeeds may introduce
   additional bindings for explicit variables (`?name`) that appear in it. Those
   bindings are visible in subsequent parameter constraints and in the
   body.

A canonical example using both effects is `here`: in the following
parameter, `?here` is bound by the relation match against `At(actor, ?here)`
even though it is not itself a parameter name:

```
actor: (Actor & Locatable) { At(actor, ?here) }
```

Constraints may use multiple statements separated by `;`. Their
combination is conjunctive: every constraint must match for the binding to
proceed.

---

## 5. Execution Model

The runtime evaluates a `Program` by interpreting top-level statements in
order (§ 3) to populate a `StoryModel`. Plays and queries are then
evaluated against the resulting model.

### 5.1 Story model

A `StoryModel` holds:

- maps of declared traits, relations, predicates, and actions, indexed by
  identifier;
- an ordered list of rules (`before` and `after`);
- a map of entities to their trait sets;
- a fact base — a set of `(relation, args)` ground tuples.

The model is the only mutable runtime artifact. The runtime never mutates
ASTs.

### 5.2 Body statements

Inside a callable body or rule body, the supported statements are:

- `when (Expr) Block` — § 5.5
- `set …` — applies effects to the model immediately (§ 6.2). Inside a
  body, `set` is permitted to reference identifiers bound by enclosing
  parameter patterns and `when` matches.
- `emit Event(args…)` — records a host-facing event on the staged action
  result (§ 6.2). Events are returned only for actions that commit.
- `succeed;` — terminates the enclosing callable's body with a successful,
  no-effect outcome and short-circuits subsequent rule evaluation as
  described in § 5.3.
- `fail;` — terminates the enclosing callable's body with a failure
  outcome and short-circuits subsequent rule evaluation as described in
  § 5.3.

A body that finishes without explicit `succeed`/`fail` is a successful pass
result if every statement executed (or, for `when` statements, matched);
otherwise the body produces a failure result and surfaces explanatory
reasons (§ 7).

### 5.3 Calling a callable

`playLanguageCall(model, "Go(Player, Outside)")` is the canonical entry
point for actions. Predicates are not played directly; they are invoked
from `when` conditions (§ 5.5). The execution flow for a single call is:

1. **Parameter binding.** Match the supplied ground arguments against the
   callable's parameter patterns, producing zero or more candidate
   environments (§ 4). If zero, the call fails with reason
   `!<callable>(args…)`.

2. **`before` rules.** Gather all rules whose phase is `before` and whose
   target is the callable's name. For each rule, re-bind the original
   positional arguments against the rule's own parameter patterns,
   starting from the caller's `baseEnv` (i.e. `{}` for a top-level play
   call). The rule's env is independent of the action's parameter
   binding — the action's parameter names are not visible inside the
   rule. Execute the rule body (§ 5.3.1).

3. **Body.** If no `before` rule emitted a terminal `succeed` or `fail`,
   execute the callable's own body in the candidate environment (§ 5.3.2).

4. **`after` rules.** Only for actions (not predicates), and only if the
   body produced a passed result, gather and run `after` rules using the
   environment after the body executed.

5. **Return.** The first candidate environment that produces a non-failure
   outcome short-circuits the search. Otherwise the runtime returns the
   accumulated failure reasons.

#### 5.3.1 Rule terminals

A `before` rule body that runs to a `succeed;` immediately short-circuits
the whole call as `passed`. A `before` rule body that runs to a `fail;`
immediately short-circuits the whole call as `failed`. A rule that exits
without a terminal contributes to the call only through its side effects
(`set …`) and through failure reasons it raised internally.

An `after` rule has the same terminal semantics with one exception:
because it runs only after the body has already passed, an `after`
terminal `succeed` is redundant. An `after` terminal `fail` flips the
call result to failed.

When a rule's `when` condition fails to match, the runtime keeps the
already-bound parameter pattern environment and records the failure
reasons only if the rule contains a `succeed;` somewhere inside it. Rules
that exist purely to fail (no `succeed;` in the body) do not emit reasons
when their `when` clause fails to match — their non-firing is a non-event,
not an error.

#### 5.3.2 Body block semantics

A block executes its statements in order. A `set` statement always
succeeds and updates the model. A `when` statement evaluates its condition
expression to a set of candidate environments; if empty, the runtime
records the condition's failure reasons and treats the statement as a
non-match (the block continues to subsequent statements but will not end
in `passed` unless reasons are cleared). For each matching environment the
runtime executes the `when` block; the first match whose block ends in
`passed` (or `succeed;`) yields the block's environment, and the first match
whose block ends in `fail;` propagates as a terminal failure.

A block whose statements all succeeded and which accumulated no failure
reasons returns `passed` in the resulting environment. A block that
accumulated failure reasons returns `failed` with those reasons.

#### 5.3.3 Failure reason discipline

Failure reasons are surfaced as compact DSL fragments. Examples produced
by the runtime today:

- `!At(Player, Outside)` — a relation atom did not hold.
- `!Locked(Bars)` — a negated condition matched a fact whose negation was
  required.
- `!Go(Player, Outside)` — no parameter binding succeeded for a callable.
- `fail` — a literal `fail;` statement (filtered from user-facing output;
  the wrapping `fail { … }` is still emitted).

A predicate evaluated as part of a `when` condition that fails contributes
its own internal failure reasons in place of `!PredicateName(args)` so
that the chain of `succeed`-rules that *could have rescued* the call is
visible to the caller.

#### 5.3.4 Action vs predicate

Both actions and predicates run their `before` rules. Only actions run
`after` rules. Predicates that fail produce a `[]` evaluation result for
their containing `when` rather than a top-level failure.

### 5.4 The `Any` type

The identifier `Any` is recognised by the runtime type-matcher as a type
expression matching every ground term, regardless of trait membership or
relation kind. It does not need to be declared as a trait, and asserting
a `relation R(Any)` lets `R` apply to any entity, literal, or relation
instance.

### 5.5 Expressions in `when` clauses

`when (Expr)` evaluates the expression and binds the resulting set of
environments. The expression grammar is:

```
Expr      ::= Expr "|" Expr           -- disjunction (left assoc)
            | Expr "&" Expr           -- conjunction (left assoc)
            | "!" Expr                -- negation as failure
            | "(" Expr ")"            -- grouping
            | Term "==" Term          -- equality / unification
            | RelationAtom            -- relation lookup or predicate call
```

Semantics:

- **Relation atom.** If the head identifier names a declared predicate,
  the runtime resolves each argument term in the current environment and
  invokes the predicate (§ 5.3); a `passed` predicate yields one
  environment, otherwise zero. If the head names an external predicate,
  the runtime resolves every argument and calls the host adapter; a truthy
  adapter result yields one environment. If the head names a relation symbol with
  stored facts, the runtime walks the fact base and produces one
  environment per matching fact, binding any explicit variables in the
  pattern.

- **Negation (`!`).** Negation-as-failure: `!E` returns the current
  environment unchanged if `E` has zero matches in that environment, and
  zero environments otherwise. Negation does not bind variables.

- **Conjunction (`&`).** Evaluates the left operand, then evaluates the
  right operand in each resulting environment. The output is the union of
  right-operand results across all left-operand environments.

- **Disjunction (`|`).** Evaluates both operands in the current
  environment and returns their deduplicated union.

- **Equality (`==`).** Both operands are resolved against the environment.
  If both ground, they must be structurally equal (same kind, same value,
  recursively equal for relation instances). If one operand is an unbound
  explicit variable, the runtime unifies the variable with the other
  operand and returns the augmented environment.

#### 5.5.1 Term shapes

Terms used in expressions include identifiers, explicit variables (`?name`),
numbers, strings, the wildcard `_`, and relation instances `R(t1, …, tn)`.
Bare identifiers resolve to an existing parameter or variable binding when
one exists; otherwise they are ground ids such as entity names. Bare
identifiers no longer introduce free query bindings.

A relation-instance term used as an *argument* to another relation
denotes a ground relation reference (e.g. `Gated(Path(?here, target),
?door)` references the relation tuple `Path(?here, target)` as the first
argument to `Gated`). A relation-instance term used as the top of an
expression is a relation lookup or predicate call.

Wildcard terms are legal inside relation patterns where they match any
value without binding. They are not legal in ground positions such as
top-level `set` effects.

### 5.6 Environments

An environment is a partial map from identifier to ground term. The
runtime carries a single environment through a chain of conjuncts,
forking it at disjunctions and at multi-match relations.

An explicit variable referenced in a relation pattern is bound by the match
if the corresponding fact argument is concrete. Subsequent uses of the same
variable within the same conjunction are constrained to that same value.
Inside a callable, parameter names are pre-bound to the supplied arguments.
MCP query rows contain all explicit variables bound by the query.

---

## 6. World State

### 6.1 Facts

A fact is a ground relation tuple `(relation, [arg, …])` where each
argument is one of:

- `{ kind: "id", id }` — an entity reference or other identifier;
- `{ kind: "string", value }` — a string literal;
- `{ kind: "number", value }` — a numeric literal;
- `{ kind: "relation", relation, args }` — a relation instance term.

Two facts are equal iff they have the same relation symbol and
structurally equal argument lists.

Every asserted or retracted fact must match the declared relation arity and
argument types. Trait-typed arguments must name declared entities carrying that
trait. Relation-typed arguments must be relation-instance ground terms whose
inner relation tuple is itself well-formed.

### 6.2 Effects and events

Effects are produced by `set` statements. They run synchronously against
the model:

- **Assert** — adds the ground tuple to the fact base (replacing any
  earlier fact with the same key) and applies cardinality (§ 6.3).
- **Retract** — removes the ground tuple from the fact base if present.

Both effects require that the relation symbol be declared. Asserting or
retracting an undeclared relation raises `LanguageModelError("unknown
relation '…'")`.

Effects inside a callable body run during execution; they are visible to
later body statements and to other rules invoked later in the same call.
Action calls are atomic: effects are staged against a candidate model and are
committed to the live model only if the action body and all applicable `after`
rules pass. A `fail;` after a successful `set`, including a failing `after`
rule, rolls back every effect produced by that action attempt. Predicate and
query evaluation is pure and cannot commit effects.

Events are produced by `emit` statements. They have the shape
`{ event: string, args: GroundTerm[] }`. Events are staged with the action
attempt and returned only if the action commits; failed actions return no
events from the rolled-back candidate.

### 6.3 Cardinality enforcement

An explicit `unique(name, ...)` relation constraint names the uniqueness key.
When asserting `R(a1, …, an)`, the runtime walks existing facts for `R` and
retracts any fact with the same values at all named key positions before
recording the new fact.

A legacy relation parameter declared `one T` is the *primary* axis of the
relation's functional dependency.

When asserting `R(a1, …, an)`, the runtime walks the existing facts for
`R`. For each existing fact whose arguments agree on all *non-`one`*
positions, that fact is retracted before the new fact is recorded.

Multiple `one` parameters together act as the set of free axes; this
allows expressing functional dependencies such as "each Locatable has at
most one Location" with `relation At(Locatable, one Location)`.

### 6.4 Entities

Entity identifiers, once introduced via `entity`, are not stored in the
fact base — they live in a separate entity map. They cannot be retracted.
`extend` is the only mutation; it monotonically adds traits.

---

## 7. Play Result Encoding

The runtime returns a `LanguagePlayResult` shape:

```ts
{
  status: "passed" | "failed";
  feedback: string;
  reasons: string[];
  effects: Effect[];
  events: Event[];
  failures: Failure[];
}
```

`feedback` is the compact DSL fragment a client may surface verbatim.
`reasons` is the deduplicated list of individual textual reasons. Pass
results always have empty reasons and failures.

Reason strings are produced by emitting the relation atom (or other
expression fragment) that failed, with environment substitutions applied.
Where a value remains unbound, the emitter prints `_`.

`effects` is the exact committed effect list for a passed action and empty for
failed actions. `events` is the exact committed event list for a passed action
and empty for failed actions. `failures` is the machine-readable diagnostic
view over the textual reasons:

```ts
type Failure = {
  kind: "unknown_action" | "action_failed" | "condition" | "terminal";
  message: string;
  callable?: string;
};
```

---

## 8. Validation Result Encoding

`runLanguageValidations(model)` returns:

```ts
{ status: "passed"; failures: [] }
| { status: "failed"; failures: [{ validation, assertion, message }, ...] }
```

`validation` is the validation declaration id. `assertion` is a one-based index
within that declaration. `message` is diagnostic text and is not the canonical
data representation of the failed assertion.

---

## 9. Static Errors

The model and parser raise structured errors:

| Class                  | Trigger                                                |
| ---------------------- | ------------------------------------------------------ |
| `LanguageParseError`   | Lexical or grammatical failures, with span.            |
| `LanguageModelError`   | Semantic failures (duplicate decls, missing trait, etc.). |

Semantic failures include unknown type names, invalid fact arity, invalid fact
argument types, unknown rule targets, rule arity mismatches, `after` rules on
predicates, and mutating predicates.

These propagate out of `parseProgram` / `loadStoryProgram` and through
the MCP layer as categorised `QueryError`, `MutationError`, or
`PlayError` with a `category` of `"parse"`, `"evaluate"`, `"scope_error"`,
or `"missing_arg"`.

---

## 10. Round-Tripping

The emitter (`emitProgram`, `emitStoryModel`) produces canonical DSL text
from a `StoryModel`. The order is:

1. traits, in declaration order;
2. relations, in declaration order;
3. predicates, in declaration order;
4. actions, in declaration order;
5. rules, in declaration order;
6. entities, in insertion order, each emitted as a single `entity` block
   that includes the union of original traits and any extensions;
7. a single trailing `set { … }` block containing all current facts as
   assertions.
8. validations, in declaration order.

`extend` is not emitted because it is folded into the entity's trait set.
Retract effects are not emitted because the fact base is normalised to
positive assertions at commit time.

A round-trip of a parsed program through the model and emitter is *not*
expected to be byte-identical to the source. It is expected to be
semantically equivalent (same declarations, same fact base, same entity
trait sets, same validation declarations).

# Engine Model — Class Diagrams

This document gives a UML-style structural view of the implicit runtime
objects that the engine creates while loading, querying, mutating, and
playing a Qualms story. It reflects the implementation in
`qualms/src/language/` and `mcp/src/` at the time of writing — no
forward-looking surface is included.

Diagrams are written in Mermaid (`classDiagram`).

---

## 1. Authored Surface (AST)

The parser produces a tree of immutable AST nodes. Every node is
`readonly`-tagged in the TypeScript definitions; nothing mutates an AST
after parsing.

```mermaid
classDiagram
  class Program {
    +statements: TopLevelStatement[]
  }

  class TraitStatement {
    +kind: "trait"
    +id: string
  }

  class RelationStatement {
    +kind: "relation"
    +id: string
    +parameters: RelationParameter[]
    +unique?: string[]
  }

  class RelationParameter {
    +name?: string
    +type: TypeExpr
    +cardinality?: "one"
  }

  class ExternPredicateStatement {
    +kind: "externPredicate"
    +id: string
    +parameters: ParameterPattern[]
  }

  class CallableStatement {
    +kind: "action" | "predicate"
    +id: string
    +parameters: ParameterPattern[]
    +body: Block
    +replace?: boolean
  }

  class RuleStatement {
    +kind: "rule"
    +phase: "before" | "after"
    +target: string
    +parameters: ParameterPattern[]
    +body: Block
  }

  class EntityStatement {
    +kind: "entity"
    +id: string
    +traits: string[]
  }

  class ExtendStatement {
    +kind: "extend"
    +id: string
    +traits: string[]
  }

  class SetStatement {
    +kind: "set"
    +effects: SetEffect[]
  }

  class ValidationStatement {
    +kind: "validation"
    +id: string
    +assertions: ValidationAssertion[]
  }

  class ValidationAssertion {
    <<union>>
    FactValidationAssertion
    QueryValidationAssertion
    PlayValidationAssertion
  }

  class SetEffect {
    +polarity: "assert" | "retract"
    +atom: RelationAtom
  }

  class ParameterPattern {
    +name?: string
    +wildcard: boolean
    +type?: TypeExpr
    +constraints: Expression[]
  }

  class TypeExpr {
    <<union>>
    +kind: "named" | "intersection"
    +id?: string
    +types?: TypeExpr[]
  }

  class Block {
    +statements: BodyStatement[]
  }

  class BodyStatement {
    <<union>>
    WhenStatement
    SetStatement
    EmitStatement
    SucceedStatement
    FailStatement
  }

  class EmitStatement {
    +kind: "emit"
    +atom: RelationAtom
  }

  class WhenStatement {
    +kind: "when"
    +condition: Expression
    +body: Block
  }

  class Expression {
    <<union>>
    RelationExpression
    NotExpression
    BinaryExpression
    EqualityExpression
  }

  class RelationAtom {
    +relation: string
    +args: Term[]
  }

  class Term {
    <<union>>
    +kind: "identifier" | "variable" | "wildcard" | "string" | "number" | "relationInstance"
  }

  Program --> "*" TraitStatement
  Program --> "*" RelationStatement
  Program --> "*" ExternPredicateStatement
  Program --> "*" CallableStatement
  Program --> "*" RuleStatement
  Program --> "*" EntityStatement
  Program --> "*" ExtendStatement
  Program --> "*" SetStatement
  Program --> "*" ValidationStatement
  RelationStatement --> "*" RelationParameter
  RelationParameter --> "1" TypeExpr
  CallableStatement --> "*" ParameterPattern
  CallableStatement --> "1" Block
  RuleStatement --> "*" ParameterPattern
  RuleStatement --> "1" Block
  ParameterPattern --> "0..1" TypeExpr
  ParameterPattern --> "*" Expression
  SetStatement --> "*" SetEffect
  SetEffect --> "1" RelationAtom
  ValidationStatement --> "*" ValidationAssertion
  Block --> "*" BodyStatement
  WhenStatement --> "1" Expression
  WhenStatement --> "1" Block
  RelationAtom --> "*" Term
```

Notes:

- `Term` of kind `relationInstance` carries a nested `RelationAtom`,
  enabling relation-valued arguments such as `Gated(Path(?here, target),
  ?door)`.
- `ParameterPattern` constraints are arbitrary `Expression` trees; they
  share grammar with `when` conditions (see `language.md` § 5.5).

---

## 2. Story Model (Runtime State)

`StoryModel` is the central runtime object. It indexes declarations and
holds the fact base.

```mermaid
classDiagram
  class StoryModel {
    +traits: Map~string, TraitStatement~
    +relations: Map~string, RelationStatement~
    +externalPredicates: Map~string, ExternPredicateStatement~
    +predicates: Map~string, CallableStatement~
    +actions: Map~string, CallableStatement~
    +rules: RuleStatement[]
    +validations: Map~string, ValidationStatement~
    +entities: Map~string, Set~string~~
    -facts: Map~string, Fact~
    +apply(program: Program) Effect[]
    +clone() StoryModel
    +hasFact(relation, args) boolean
    +listFacts(relation?) Fact[]
    +assertFact(fact) void
    +retractFact(fact) void
    +entityTraits(id) Set~string~
  }

  class Fact {
    +relation: string
    +args: GroundTerm[]
  }

  class GroundTerm {
    <<union>>
    +kind: "id" | "string" | "number" | "relation"
    +id?: string
    +value?: string | number
    +relation?: string
    +args?: GroundTerm[]
  }

  class LanguageModelError {
    +name: "LanguageModelError"
    +message: string
  }

  StoryModel "1" o-- "*" Fact : facts (private)
  Fact --> "*" GroundTerm

  StoryModel ..> LanguageModelError : throws
```

Invariants:

- `traits`, `relations`, `predicates`, `actions` keys are unique. The
  `replace` modifier on a `CallableStatement` overwrites the existing
  entry in place; non-`replace` redeclaration raises
  `LanguageModelError`.
- `rules` is order-preserving and never deduplicated — order is the
  authoring order, and rule evaluation follows that order
  (`runtime.ts:runRules`).
- `entities` keys are unique. `extend` mutates the trait set in place
  (additive only).
- `facts` is keyed by `factKey(fact)` (`relation|JSON(args)`).
- `validations` keys are unique and declaration-order preserving. They do
  not execute during load; they run through `runLanguageValidations`.
- `clone()` produces a deep-enough copy for transaction snapshots: a
  fresh `StoryModel` with new `Map`/`Set` containers, sharing AST nodes
  by reference. This is provisional — see
  `memory/project_transaction_model.md` for the migration plan to an
  amend layer.

---

## 3. Runtime Helpers

The runtime is functional — it does not introduce long-lived objects
beyond an in-flight `Env`. The notable types are listed here for
reference because they appear in protocol traces (`protocol.md`).

```mermaid
classDiagram
  class Env {
    <<type alias>>
    Record~string, GroundTerm~
  }

  class LanguagePlayResult {
    +status: "passed" | "failed"
    +feedback: string
    +reasons: string[]
    +effects: Effect[]
    +events: LanguageEvent[]
    +failures: LanguageFailure[]
  }

  class LanguageEvent {
    +event: string
    +args: GroundTerm[]
  }

  class LanguageFailure {
    +kind: "unknown_action" | "action_failed" | "condition" | "terminal"
    +message: string
    +callable?: string
  }

  class LanguageValidationResult {
    +status: "passed" | "failed"
    +failures: LanguageValidationFailure[]
  }

  class LanguageValidationFailure {
    +validation: string
    +assertion: number
    +message: string
  }

  class BlockResult {
    <<internal>>
    +status: "passed" | "failed" | "no_match"
    +env: Env
    +reasons: string[]
    +terminal?: "succeed" | "fail"
  }

  class LanguageParseError {
    +name: "LanguageParseError"
    +span?: { offset, line, column }
  }

  LanguagePlayResult ..> Env : produced from terminal Env
  BlockResult --> "1" Env
```

`BlockResult` is the internal contract returned by every body-statement
and rule evaluator. It is not exported. `LanguagePlayResult` is the
external shape returned by `playLanguageCall`. Action execution is staged on
a cloned `StoryModel`; the returned `effects` are committed to the live model
only after the action body and all applicable `after` rules pass.

`LanguageValidationResult` is the external shape returned by
`runLanguageValidations`. Validation play assertions use a cloned model and
discard their effects.

---

## 4. MCP Session Layer

The MCP package owns sessions, transactions, and the tool entry points.
A `SessionManager` is the single root managing concurrent sessions for a
running server.

```mermaid
classDiagram
  class SessionManager {
    -sessions: Map~string, Session~
    +start(options) Session
    +get(sessionId) Session
    +has(sessionId) boolean
    +quit(sessionId) boolean
    +size() number
    +beginTransaction(sessionId, targetPath?) LanguageTransaction
    +requireTransaction(sessionId, transactionId) { session, transaction }
    +applyToTransaction(sessionId, transactionId, source) void
    +rollback(sessionId, transactionId) { discarded }
    +commit(sessionId, transactionId) { committed, transaction }
  }

  class Session {
    +id: string
    +model: StoryModel
    +storyPaths: readonly string[]
    +transaction: LanguageTransaction | null
  }

  class LanguageTransaction {
    +id: string
    +snapshot: StoryModel
    +applied: string[]
    +targetPath?: string
  }

  class SessionNotFoundError
  class TransactionNotFoundError
  class TransactionAlreadyOpenError

  SessionManager "1" o-- "*" Session
  Session "1" *-- "1" StoryModel : live model
  Session "1" o-- "0..1" LanguageTransaction : open tx
  LanguageTransaction "1" *-- "1" StoryModel : snapshot

  SessionManager ..> SessionNotFoundError : throws
  SessionManager ..> TransactionNotFoundError : throws
  SessionManager ..> TransactionAlreadyOpenError : throws
```

Lifecycle invariants:

- A `Session` owns exactly one live `StoryModel`. Queries always operate
  on this live model, even mid-transaction. Mutations applied to a
  transaction modify the live model directly; rollback restores from the
  snapshot.
- A `Session` has at most one open `LanguageTransaction` at a time. Calls
  to `beginTransaction` against a session with an open transaction throw
  `TransactionAlreadyOpenError`.
- `applied` is an append-only list of the raw DSL source fragments fed
  into the transaction. `diff` returns this list verbatim.
- `targetPath` defaults to the session's single loaded story path if
  exactly one was provided; otherwise it must be passed explicitly to
  `beginTransaction`. Without a `targetPath`, `commit` finalises the
  transaction in memory but does not persist.

---

## 5. MCP Tool Layer

The tool handlers are thin functions over `SessionManager`. They are
shown here as a service surface to ground the sequence diagrams in
`protocol.md`.

```mermaid
classDiagram
  class ToolHandlers {
    <<module>>
    +handleStart(manager, input) StartOutput
    +handleQuit(manager, input) QuitOutput
    +handleQuery(manager, input) QueryOutput
    +handleBegin(manager, input) BeginOutput
    +handleMutate(manager, input) MutateOutput
    +handleDiff(manager, input) DiffOutput
    +handleCommit(manager, input) CommitOutput
    +handleRollback(manager, input) RollbackOutput
    +handlePlay(manager, input) PlayOutput
  }

  class QueryError {
    +category: "parse" | "evaluate"
  }

  class MutationError {
    +category: "parse" | "scope_error"
  }

  class PlayError {
    +category: "parse" | "missing_arg"
  }

  class McpServer {
    +registerTool(name, schema, handler)
    +connect(transport)
  }

  ToolHandlers ..> SessionManager : delegates
  ToolHandlers ..> StoryModel : reads
  ToolHandlers ..> QueryError : throws
  ToolHandlers ..> MutationError : throws
  ToolHandlers ..> PlayError : throws
  McpServer ..> ToolHandlers : routes tools
```

Tool surface (`server.ts:buildServer`): `start`, `quit`, `query`,
`begin`, `mutate`, `diff`, `commit`, `rollback`, `play`. Each tool's
input and output shapes are codified by Zod schemas in `server.ts` and
TypeScript interfaces in `tools.ts`.

Error mapping in `server.ts:errorResult`:

- `QueryError | MutationError | PlayError` → `"[<category>] <message>"`
  with `isError: true`.
- `SessionNotFoundError | TransactionNotFoundError |
  TransactionAlreadyOpenError` → message only, `isError: true`.
- Any other `Error` → message only, `isError: true`.

---

## 6. Object Ownership Summary

```mermaid
classDiagram
  class McpServer
  class SessionManager
  class Session
  class StoryModel
  class LanguageTransaction
  class Program

  McpServer *-- "1" SessionManager
  SessionManager *-- "*" Session
  Session *-- "1" StoryModel : live
  Session o-- "0..1" LanguageTransaction
  LanguageTransaction *-- "1" StoryModel : snapshot
  StoryModel ..> Program : .apply(program)
```

In words:

- The `McpServer` owns one `SessionManager` for its lifetime.
- The `SessionManager` owns all `Session` instances.
- Each `Session` owns its live `StoryModel`.
- An open `LanguageTransaction` owns a cloned `StoryModel` snapshot.
- A `Program` is transient: parsed, applied to a `StoryModel`, then
  discarded. The runtime keeps only the AST nodes it needs through the
  declaration maps and `rules` list inside the model.

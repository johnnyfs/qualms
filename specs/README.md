# Specs

Strict specifications for the Qualms DSL, runtime, and MCP protocol. These
docs describe what is **already implemented** on branch `js-migration`
(parser, model, runtime, emitter, MCP session and tools). They are not
roadmaps; the tutorial fixture under `stories/tutorial/tutorial.qualms` is
the authoring target and may temporarily run ahead of the engine. Features
hinted there but not yet implemented are listed in the TODO below.

Scope boundary: prior planning docs for the old YAML/Python engine and the
DSL v2 prototype live under `deprecated/typescript-legacy/specs/`. They are
no longer normative.

## Index

| Document                                  | Covers                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| [`language.md`](./language.md)            | Lexical structure, grammar (EBNF), declarations, parameter patterns, execution model, world-state semantics, errors, round-tripping. |
| [`engine-model.md`](./engine-model.md)    | UML class diagrams for AST, `StoryModel`, runtime helpers, MCP session/tool layers, and ownership summary. |
| [`protocol.md`](./protocol.md)            | UML sequence diagrams for every registered MCP tool (`start`, `quit`, `query`, `begin`, `mutate`, `diff`, `commit`, `rollback`, `play`) and the error taxonomy. |
| [`portable-ir.md`](./portable-ir.md)      | Language-neutral AST, world, fact/effect, runtime operation, and host adapter contract for reimplementations. |

## Conventions

- Class and sequence diagrams use Mermaid (`classDiagram`, `sequenceDiagram`).
- File and symbol references use `path:line` where they would help a reader
  navigate the implementation directly.
- Where the specs use "today" or "currently", they refer to the state of
  `qualms/src/language/` and `mcp/src/` at the moment the doc was written.
  When implementation changes, the spec must be updated in lockstep.

## TODO

The list is split into items that need engine work before the spec can
describe them, and items that are purely documentation work. Order is
roughly priority for the spec author. Tick items off as features land.

### Blocked on engine features

- [ ] **Action arity beyond two named params.** The tutorial's section 7
      uses a three-argument `TalkAbout(actor, speaker, topic)`. Runtime
      already supports arbitrary arity; verify and document any limits in
      `language.md` § 5.3 once tests exist for n≥3 actions.
- [ ] **Predicate extensibility via `before` rules.** Section 6 of the
      tutorial extends `IsVisibleTo` with a `before` rule. The current
      runtime evaluates `before` rules on predicates; the spec asserts
      this in § 5.3.4 but the contract needs explicit conformance tests.
- [ ] **Trait intersection in standalone positions.** Currently
      intersections are only legal in parenthesised type expressions
      inside a parameter pattern. If/when the language permits them
      elsewhere (e.g. `relation R(Actor & Locatable)` without parens),
      update grammar § 2 and § 4.2.
- [ ] **Numbers, strings, and arithmetic.** Literals parse today, but the
      runtime has no operators beyond `==`. Document the literal-vs-id
      distinction once any arithmetic or comparison is added.
- [ ] **Negation across predicates with `set` side effects.** The current
      `!E` is negation-as-failure with no environment mutation; if the
      runtime ever lets a predicate's failure surface its own side
      effects through negation, § 5.5 needs revision.
- [ ] **Persistence beyond a single `targetPath`.** `commit` only writes
      when the transaction was bound to a single `.qualms` file. Define
      behavior for multi-file commits and any normalisation across files
      once supported.
- [ ] **Transaction model migration.** The current snapshot-by-deep-clone
      is provisional (see `memory/project_transaction_model.md`). When
      the amend layer (base + delta) lands, rewrite `engine-model.md` § 4
      and `protocol.md` § 3.

### Documentation-only work

- [x] **Concrete error taxonomy table.** Cross-reference every thrown
      error in `qualms/src/language/` and `mcp/src/` against the table
      in `protocol.md` § 5. `scope_error` is used for validation-gated
      commit failures.
- [x] **Conformance suite spec.** Promote `stories/tutorial/tutorial.qualms`
      to a normative conformance fixture: enumerate the section-by-section
      capabilities it exercises and map each to grammar/runtime sections.
- [ ] **Play-feedback grammar.** The current `fail { reason; reason; }`
      shape is described informally in `language.md` § 7. Give it a
      concrete grammar and worked examples drawn from the runtime tests.
- [ ] **`query` expression dialect.** `query` accepts a subset of the
      `Expr` grammar (no `set`, no terminal `succeed`/`fail`). Document the
      exact accepted subset and how `knownEntityBindings` shapes the
      result rows.
- [ ] **`show` command grammar.** Spec out the `^show( <kind>)?( <name>)?$`
      surface explicitly in `protocol.md` and enumerate the recognised
      kinds.
- [ ] **Round-trip conformance.** State the invariants that
      `emitStoryModel(parseProgram(s))` must satisfy and link to the
      tests that enforce them.
- [ ] **MCP transport coverage.** `start`/`quit` are documented at the
      tool layer but the transport (stdio, etc.) is not. Decide whether
      transport details belong here or in `mcp/README.md`.
- [ ] **Glossary.** Add a short glossary covering trait, relation,
      entity, predicate, action, rule, fact, env, candidate environment.

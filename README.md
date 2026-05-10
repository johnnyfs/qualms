# Qualms

Qualms is now centered on the prelude-free tutorial DSL in `qualms/specs/tutorial.qualms`.
The active implementation is the TypeScript language package plus an MCP server that
loads, mutates, queries, and plays stories written in that syntax.

The old Python/YAML prototype, old TypeScript engine, old examples, and old story
fixtures have been moved under `deprecated/` for reference. They are no longer part
of the supported runtime or test surface.

## Active Layout

- `qualms/src/language/`: parser, model, emitter, and runtime for the current DSL.
- `qualms/specs/tutorial.qualms`: conformance-style tutorial fixture for the current DSL features.
- `qualms/test/`: language parser/model/runtime tests.
- `mcp/src/`: MCP lifecycle, query, transaction, mutate, commit, rollback, and play tools for current-syntax `.qualms` stories.
- `mcp/test/`: direct and subprocess MCP tests.
- `deprecated/`: previous prototypes, YAML assets, old examples, old docs, and old tests.

## DSL Shape

The current `.qualms` syntax supports:

- `trait`, `relation`, `predicate`, `action`, `before`, `after`, `entity`, `extend`, and `set`
- pattern-constrained parameters such as `actor: (Actor & Locatable) { At(actor, here) }`
- relation-valued terms such as `Gated(Path(Cell, Corridor), Bars)`
- boolean conditions with `!`, `&`, `|`, and `==`
- compact play feedback such as `pass;` and `fail { Locked(Bars); }`

## Development

Install dependencies:

```sh
pnpm install
```

Run tests:

```sh
pnpm -r test
```

Run type checks:

```sh
pnpm -r typecheck
```

Run the MCP server:

```sh
pnpm --filter @quealm/mcp start
```

MCP clients start sessions by calling `start` with `storyPaths` that point to
current-syntax `.qualms` files.

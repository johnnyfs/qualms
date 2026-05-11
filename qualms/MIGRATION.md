# Migration Status

The active migration target is the prelude-free tutorial DSL. There is no
supported prelude, YAML story format, legacy query DSL, or prior TypeScript DSL
surface in the active packages.

Current active surface:

- `qualms/src/language/` parses, emits, models, and executes current-syntax `.qualms`.
- `stories/tutorial/tutorial.qualms` is the conformance fixture for language concepts.
- `mcp/src/` exposes MCP tools over arbitrary stories written in the current DSL syntax.

Deprecated material was moved under `deprecated/` and is retained only as reference.

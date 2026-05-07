#!/usr/bin/env node
/**
 * CLI entry point for the qualms MCP server.
 *
 * Usage:
 *   qualms-mcp --core <path/to/core.qualms.yaml> [--story <path>]...
 *
 * The server reads/writes MCP messages on stdio. `--core` is required and
 * declares the protected prelude path (defaults to the migrated prelude when
 * not specified, but only if it exists at the conventional location).
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startServer } from "./server.js";

interface ParsedArgs {
  corePath?: string;
  storyPaths: string[];
  showHelp: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { storyPaths: [], showHelp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--core") {
      args.corePath = argv[++i];
    } else if (a === "--story") {
      const next = argv[++i];
      if (next) args.storyPaths.push(next);
    } else if (a === "--help" || a === "-h") {
      args.showHelp = true;
    }
  }
  return args;
}

function defaultCorePath(): string | undefined {
  // src/ is one level above the package root after compile; resolve relative to
  // this file's directory and walk up to find prelude.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../prelude/core.qualms.yaml"),
    resolve(here, "../../qualms/prelude/core.qualms.yaml"),
    resolve(here, "../../../qualms/prelude/core.qualms.yaml"),
  ];
  return candidates.find((p) => existsSync(p));
}

function printHelp(): void {
  process.stdout.write(
    `qualms-mcp — MCP server for the Qualms engine\n\n` +
      `Usage:\n` +
      `  qualms-mcp --core <prelude.yaml> [--story <story.yaml>]...\n\n` +
      `Options:\n` +
      `  --core   PATH   Path to the prelude (required if not auto-discoverable).\n` +
      `  --story  PATH   Path to a story file. Repeatable.\n` +
      `  --help          Show this message.\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.showHelp) {
    printHelp();
    return;
  }
  const corePath = args.corePath ?? defaultCorePath();
  if (!corePath) {
    process.stderr.write(
      "qualms-mcp: --core is required (no default prelude found)\n",
    );
    printHelp();
    process.exit(2);
  }
  if (!existsSync(corePath)) {
    process.stderr.write(`qualms-mcp: core path not found: ${corePath}\n`);
    process.exit(2);
  }
  const transport = new StdioServerTransport();
  await startServer(transport);

  // The server doesn't use --core/--story to auto-load; sessions are started
  // by the client via the __start tool. We surface the resolved path on stderr
  // so operators know which prelude is available.
  process.stderr.write(
    `qualms-mcp: ready (prelude at ${corePath}, ${args.storyPaths.length} story files configured)\n`,
  );

  // Keep the process alive until the transport closes.
  process.on("SIGINT", () => {
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`qualms-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

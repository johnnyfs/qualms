#!/usr/bin/env node
import { existsSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startServer } from "./server.js";

interface ParsedArgs {
  storyPaths: string[];
  showHelp: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { storyPaths: [], showHelp: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--story") {
      const next = argv[++i];
      if (next) args.storyPaths.push(next);
    } else if (arg === "--help" || arg === "-h") {
      args.showHelp = true;
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `qualms-mcp - MCP server for the Qualms tutorial DSL\n\n` +
      `Usage:\n` +
      `  qualms-mcp [--story <story.qualms>]...\n\n` +
      `Options:\n` +
      `  --story  PATH   Optional story file path to advertise in startup logs. Sessions load files via the start tool.\n` +
      `  --help          Show this message.\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.showHelp) {
    printHelp();
    return;
  }
  for (const storyPath of args.storyPaths) {
    if (!existsSync(storyPath)) {
      process.stderr.write(`qualms-mcp: story path not found: ${storyPath}\n`);
      process.exit(2);
    }
  }

  const transport = new StdioServerTransport();
  await startServer(transport);
  process.stderr.write(`qualms-mcp: ready (${args.storyPaths.length} story paths advertised)\n`);

  process.on("SIGINT", () => {
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`qualms-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

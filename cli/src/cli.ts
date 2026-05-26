#!/usr/bin/env node
import { existsSync } from "node:fs";
import { render } from "ink";
import React from "react";
import { App } from "./app.js";
import { loadStories } from "./story.js";
import { language } from "@quealm/qualms";
import { loadCoauthorConfig } from "./coauthor/config.js";
import {
  defaultPlayConfig,
  discoverPlayConfigPath,
  loadPlayConfig,
  validatePlayConfig,
  type PlayConfig,
} from "./play/config.js";

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
    } else if (arg && !arg.startsWith("-")) {
      args.storyPaths.push(arg);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `qualms-cli - Ink-based DSL + play prompt for the Qualms story model\n\n` +
      `Usage:\n` +
      `  qualms-cli [--story <story.qualms>]... [positional story paths]\n\n` +
      `Options:\n` +
      `  --story  PATH         Load a story file at startup. Repeatable; positional paths also accepted.\n` +
      `  --help                Show this message.\n`,
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.showHelp) {
    printHelp();
    return;
  }

  for (const storyPath of args.storyPaths) {
    if (!existsSync(storyPath)) {
      process.stderr.write(`qualms-cli: story path not found: ${storyPath}\n`);
      process.exit(2);
    }
  }

  let initialModel: language.StoryModel;
  let resolvedPaths: readonly string[];
  let playConfig: PlayConfig;
  try {
    const loaded = loadStories(args.storyPaths);
    initialModel = loaded.model;
    resolvedPaths = loaded.resolvedPaths;
    const configPath = resolvedPaths.map(discoverPlayConfigPath).find(Boolean);
    playConfig = configPath ? loadPlayConfig(configPath) : defaultPlayConfig();
    for (const warning of validatePlayConfig(playConfig, initialModel)) {
      process.stderr.write(`qualms-cli: ${warning}\n`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`qualms-cli: failed to load stories: ${message}\n`);
    process.exit(1);
  }

  const coauthorConfig = loadCoauthorConfig();

  render(
    React.createElement(App, {
      initialModel,
      storyPaths: resolvedPaths,
      playConfig,
      coauthorConfig,
    }),
  );
}

main();

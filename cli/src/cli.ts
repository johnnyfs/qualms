#!/usr/bin/env node
import { existsSync } from "node:fs";
import { render } from "ink";
import React from "react";
import { App } from "./app.js";
import { loadStories } from "./story.js";
import { language } from "@quealm/qualms";
import {
  defaultPlayConfig,
  discoverPlayConfigPath,
  loadPlayConfig,
  PlayConfigError,
  validatePlayConfig,
  type PlayConfig,
} from "./play/config.js";
import { loadCoauthorConfig } from "./coauthor/config.js";

interface ParsedArgs {
  storyPaths: string[];
  playConfigPath?: string;
  showHelp: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { storyPaths: [], showHelp: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--story") {
      const next = argv[++i];
      if (next) args.storyPaths.push(next);
    } else if (arg === "--play-config") {
      const next = argv[++i];
      if (next) args.playConfigPath = next;
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
      `  qualms-cli [--story <story.qualms>]... [--play-config <story.play.yaml>] [positional story paths]\n\n` +
      `Options:\n` +
      `  --story  PATH         Load a story file at startup. Repeatable; positional paths also accepted.\n` +
      `  --play-config PATH    Load a sidecar play-test config. Default: <story>.play.yaml next to the first story file.\n` +
      `  --help                Show this message.\n`,
  );
}

function resolvePlayConfig(
  storyPaths: readonly string[],
  explicit: string | undefined,
): { config: PlayConfig; source?: string } {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`play config not found: ${explicit}`);
    }
    return { config: loadPlayConfig(explicit), source: explicit };
  }
  for (const storyPath of storyPaths) {
    const sidecar = discoverPlayConfigPath(storyPath);
    if (sidecar) return { config: loadPlayConfig(sidecar), source: sidecar };
  }
  return { config: defaultPlayConfig() };
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
  try {
    const loaded = loadStories(args.storyPaths);
    initialModel = loaded.model;
    resolvedPaths = loaded.resolvedPaths;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`qualms-cli: failed to load stories: ${message}\n`);
    process.exit(1);
  }

  let playConfig: PlayConfig;
  let playConfigSource: string | undefined;
  try {
    const resolved = resolvePlayConfig(resolvedPaths, args.playConfigPath);
    playConfig = resolved.config;
    playConfigSource = resolved.source;
  } catch (e) {
    const message =
      e instanceof PlayConfigError || e instanceof Error ? e.message : String(e);
    process.stderr.write(`qualms-cli: failed to load play config: ${message}\n`);
    process.exit(1);
  }

  const playWarnings = validatePlayConfig(playConfig, initialModel);
  const coauthorConfig = loadCoauthorConfig();

  render(
    React.createElement(App, {
      initialModel,
      storyPaths: resolvedPaths,
      playConfig,
      playConfigSource,
      playWarnings,
      coauthorConfig,
    }),
  );
}

main();

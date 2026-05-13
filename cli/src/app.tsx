import { Box, useApp } from "ink";
import { useCallback, useMemo, useRef, useState } from "react";
import type { language } from "@quealm/qualms";
import { Header } from "./components/Header.js";
import { Transcript } from "./components/Transcript.js";
import { Prompt } from "./components/Prompt.js";
import { Footer } from "./components/Footer.js";
import { handleInput } from "./handleInput.js";
import { loadStories } from "./story.js";
import type { KeyedTranscriptEntry, TranscriptEntry } from "./types.js";
import {
  defaultPlayConfig,
  type PlayConfig,
} from "./play/config.js";
import {
  createPlaySession,
  handlePlayInput,
  renderInitialView,
  type PlaySession,
} from "./play/runner.js";
import { suggest, type Suggestion } from "./play/suggest.js";

type Mode = "dsl" | "play";

interface AppProps {
  readonly initialModel: language.StoryModel;
  readonly storyPaths: readonly string[];
  readonly playConfig?: PlayConfig;
  readonly playConfigSource?: string;
  readonly playWarnings?: readonly string[];
}

const DSL_HELP_LINES: readonly string[] = [
  "DSL mode — type a relation atom (Go(Player, Corridor)), a program",
  "statement (set { ... }, entity Foo { ... }), or a slash command:",
  "  /help        show this help",
  "  /show        print the current model counts",
  "  /reload      re-load the original story file(s)",
  "  /mode <m>    switch mode (dsl | play); shift-tab also cycles",
  "  /quit        leave the app (Ctrl+C also works)",
];

const PLAY_HELP_LINES: readonly string[] = [
  "Play mode — type natural commands like 'take key' or 'go to corridor'.",
  "  Tab          accept the highlighted suggestion",
  "  Up/Down      navigate suggestions",
  "  /look        re-render the current room",
  "  /mode dsl    switch back to DSL mode (shift-tab also cycles)",
];

export function App({
  initialModel,
  storyPaths,
  playConfig,
  playConfigSource,
  playWarnings,
}: AppProps) {
  const { exit } = useApp();
  const [model, setModel] = useState(initialModel);
  const [mode, setMode] = useState<Mode>("dsl");
  const [hasLooked, setHasLooked] = useState(false);

  const config = useMemo(() => playConfig ?? defaultPlayConfig(), [playConfig]);
  const session = useMemo<PlaySession>(
    () => createPlaySession(model, config),
    [model, config],
  );

  const seqRef = useRef(0);
  const keyed = useCallback(
    (entries: readonly TranscriptEntry[]): KeyedTranscriptEntry[] =>
      entries.map((entry) => ({ ...entry, seq: seqRef.current++ })),
    [],
  );

  const [transcript, setTranscript] = useState<readonly KeyedTranscriptEntry[]>(() => {
    const entries: TranscriptEntry[] = [];
    if (playConfigSource) {
      entries.push({ kind: "info", text: `play config: ${playConfigSource}` });
    }
    for (const warning of playWarnings ?? []) {
      entries.push({ kind: "error", text: warning });
    }
    return entries.map((entry) => ({ ...entry, seq: seqRef.current++ }));
  });

  const append = useCallback(
    (next: readonly TranscriptEntry[]) => {
      const enriched = keyed(next);
      setTranscript((current) => [...current, ...enriched]);
    },
    [keyed],
  );

  const helpLines = mode === "play" ? PLAY_HELP_LINES : DSL_HELP_LINES;

  const runSlash = useCallback(
    (command: string): readonly TranscriptEntry[] => {
      const parts = command.split(/\s+/);
      const head = parts[0] ?? "";
      switch (head) {
        case "/quit":
        case "/exit":
          exit();
          return [{ kind: "info", text: "bye." }];
        case "/help":
          return helpLines.map((text) => ({ kind: "info", text }) as TranscriptEntry);
        case "/show":
          return [
            {
              kind: "info",
              text: `traits ${model.traits.size}  relations ${model.relations.size}  predicates ${model.predicates.size}  actions ${model.actions.size}  entities ${model.entities.size}  facts ${model.listFacts().length}`,
            },
          ];
        case "/reload": {
          if (storyPaths.length === 0) {
            return [{ kind: "error", text: "error: no story paths to reload" }];
          }
          try {
            const reloaded = loadStories(storyPaths);
            setModel(reloaded.model);
            setHasLooked(false);
            return [{ kind: "info", text: `reloaded ${storyPaths.length} story file(s)` }];
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return [{ kind: "error", text: `error: ${message}` }];
          }
        }
        case "/mode": {
          const target = parts[1]?.toLowerCase();
          if (target !== "dsl" && target !== "play") {
            return [{ kind: "error", text: "usage: /mode dsl | /mode play" }];
          }
          if (target === mode) {
            return [{ kind: "info", text: `already in ${mode} mode` }];
          }
          return cycleTo(target);
        }
        case "/look": {
          if (mode !== "play") {
            return [{ kind: "error", text: "/look is only available in play mode" }];
          }
          return renderInitialView(session);
        }
        default:
          return [{ kind: "error", text: `error: unknown command '${head}'` }];
      }
    },
    [exit, helpLines, mode, model, session, storyPaths],
  );

  const cycleTo = useCallback(
    (next: Mode): readonly TranscriptEntry[] => {
      setMode(next);
      const entries: TranscriptEntry[] = [
        { kind: "info", text: `mode: ${next}` },
      ];
      if (next === "play" && !hasLooked) {
        setHasLooked(true);
        entries.push(...renderInitialView(session));
      }
      return entries;
    },
    [hasLooked, session],
  );

  const onCycleMode = useCallback(() => {
    const next: Mode = mode === "dsl" ? "play" : "dsl";
    append(cycleTo(next));
  }, [append, cycleTo, mode]);

  const suggestFn = useCallback(
    (value: string): readonly Suggestion[] =>
      suggest(value, session.verbs, session.names),
    [session],
  );

  const onSubmit = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (text.length === 0) return;
      const echo: TranscriptEntry = { kind: "input", text: `> ${text}` };
      if (text.startsWith("/")) {
        append([echo, ...runSlash(text)]);
        return;
      }
      if (mode === "play") {
        const entries = handlePlayInput(session, text);
        append([echo, ...entries]);
        return;
      }
      const entries = handleInput(model, text);
      append([echo, ...entries]);
    },
    [append, mode, model, runSlash, session],
  );

  return (
    <Box flexDirection="column">
      <Header model={model} storyPaths={storyPaths} />
      <Transcript entries={transcript} />
      <Prompt
        mode={mode}
        onSubmit={onSubmit}
        onCycleMode={onCycleMode}
        suggest={suggestFn}
      />
      <Footer mode={mode} />
    </Box>
  );
}

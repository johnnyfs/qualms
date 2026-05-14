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
  type PlaySession,
} from "./play/runner.js";
import {
  MenuController,
  initialPlayUiState,
  type PlayUiState,
} from "./play/MenuController.js";
import {
  isCoauthorConfigError,
  type CoauthorConfigResult,
} from "./coauthor/config.js";
import {
  cancelCoauthor,
  createCoauthorSession,
  handleCoauthorInput,
  type CoauthorSession,
} from "./coauthor/runner.js";

type Mode = "dsl" | "play" | "coauthor";

interface AppProps {
  readonly initialModel: language.StoryModel;
  readonly storyPaths: readonly string[];
  readonly playConfig?: PlayConfig;
  readonly playConfigSource?: string;
  readonly playWarnings?: readonly string[];
  readonly coauthorConfig?: CoauthorConfigResult;
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

const COAUTHOR_HELP_LINES: readonly string[] = [
  "Coauthor mode — describe a change in natural language. The agent",
  "runs queries, plays actions, and applies DSL mutations against the",
  "live model. All tool calls stream as pure DSL.",
  "  /cancel      abort an in-flight agent turn or pending question",
  "  /mode dsl    switch back to DSL mode (shift-tab also cycles)",
  "Configure provider/model via .env (see .env.template).",
];

export function App({
  initialModel,
  storyPaths,
  playConfig,
  playConfigSource,
  playWarnings,
  coauthorConfig,
}: AppProps) {
  const { exit } = useApp();
  const [model, setModel] = useState(initialModel);
  const [mode, setMode] = useState<Mode>("dsl");
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const [playUiState, setPlayUiState] = useState<PlayUiState>(initialPlayUiState);

  const config = useMemo(() => playConfig ?? defaultPlayConfig(), [playConfig]);
  const session = useMemo<PlaySession>(
    () => createPlaySession(model, config),
    [model, config],
  );

  const coauthorSessionRef = useRef<CoauthorSession | null>(null);
  const getCoauthorSession = useCallback((): CoauthorSession | null => {
    if (!coauthorConfig || isCoauthorConfigError(coauthorConfig)) return null;
    if (
      !coauthorSessionRef.current ||
      coauthorSessionRef.current.model !== model
    ) {
      coauthorSessionRef.current = createCoauthorSession(model, coauthorConfig);
    }
    return coauthorSessionRef.current;
  }, [coauthorConfig, model]);

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

  const helpLines =
    mode === "play"
      ? PLAY_HELP_LINES
      : mode === "coauthor"
        ? COAUTHOR_HELP_LINES
        : DSL_HELP_LINES;

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
            setPlayUiState(initialPlayUiState);
            return [{ kind: "info", text: `reloaded ${storyPaths.length} story file(s)` }];
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return [{ kind: "error", text: `error: ${message}` }];
          }
        }
        case "/mode": {
          const target = parts[1]?.toLowerCase();
          if (target !== "dsl" && target !== "play" && target !== "coauthor") {
            return [
              { kind: "error", text: "usage: /mode dsl | /mode play | /mode coauthor" },
            ];
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
          return [
            {
              kind: "info",
              text: "(in play mode, the room is always visible in the room panel)",
            },
          ];
        }
        case "/cancel": {
          if (mode !== "coauthor") {
            return [{ kind: "error", text: "/cancel is only available in coauthor mode" }];
          }
          const cs = coauthorSessionRef.current;
          if (!cs || (!cs.running && !cs.pending)) {
            return [{ kind: "info", text: "nothing to cancel" }];
          }
          cancelCoauthor(cs, { append, setPendingQuestion });
          return [{ kind: "info", text: "cancel requested" }];
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
      if (next === "coauthor" && coauthorConfig && isCoauthorConfigError(coauthorConfig)) {
        entries.push({
          kind: "error",
          text: `error: ${coauthorConfig.error}`,
        });
      } else if (next === "coauthor" && !coauthorConfig) {
        entries.push({
          kind: "error",
          text: "error: coauthor mode is not configured (missing .env)",
        });
      }
      return entries;
    },
    [coauthorConfig],
  );

  const onCycleMode = useCallback(() => {
    const next: Mode =
      mode === "dsl" ? "play" : mode === "play" ? "coauthor" : "dsl";
    append(cycleTo(next));
  }, [append, cycleTo, mode]);

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
        // Play mode is menu-driven; text input is impossible (this branch
        // is unreachable since MenuController replaces the prompt).
        return;
      }
      if (mode === "coauthor") {
        append([echo]);
        const cs = getCoauthorSession();
        if (!cs) {
          const reason =
            coauthorConfig && isCoauthorConfigError(coauthorConfig)
              ? coauthorConfig.error
              : "coauthor mode is not configured (missing .env)";
          append([{ kind: "error", text: `error: ${reason}` }]);
          return;
        }
        void handleCoauthorInput(cs, text, { append, setPendingQuestion });
        return;
      }
      const entries = handleInput(model, text);
      append([echo, ...entries]);
    },
    [append, coauthorConfig, getCoauthorSession, mode, model, runSlash],
  );

  if (mode === "play") {
    return (
      <MenuController
        session={session}
        state={playUiState}
        setState={setPlayUiState}
        onCycleMode={onCycleMode}
        onExit={exit}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Header model={model} storyPaths={storyPaths} />
      <Transcript entries={transcript} />
      <Prompt
        mode={mode}
        onSubmit={onSubmit}
        onCycleMode={onCycleMode}
        onExit={exit}
        pendingQuestion={pendingQuestion}
      />
      <Footer mode={mode} />
    </Box>
  );
}

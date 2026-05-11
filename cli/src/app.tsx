import { Box, useApp } from "ink";
import { useCallback, useState } from "react";
import type { language } from "@quealm/qualms";
import { Header } from "./components/Header.js";
import { Transcript } from "./components/Transcript.js";
import { Prompt } from "./components/Prompt.js";
import { Footer } from "./components/Footer.js";
import { handleInput } from "./handleInput.js";
import { loadStories } from "./story.js";
import type { TranscriptEntry } from "./types.js";

interface AppProps {
  readonly initialModel: language.StoryModel;
  readonly storyPaths: readonly string[];
}

const HELP_LINES: readonly string[] = [
  "DSL mode — type a relation atom (Go(Player, Corridor)), a program",
  "statement (set { ... }, entity Foo { ... }), or a slash command:",
  "  /help    show this help",
  "  /show    print the current model counts",
  "  /reload  re-load the original story file(s)",
  "  /quit    leave the app (Ctrl+C also works)",
];

export function App({ initialModel, storyPaths }: AppProps) {
  const { exit } = useApp();
  const [model, setModel] = useState(initialModel);
  const [transcript, setTranscript] = useState<readonly TranscriptEntry[]>([]);
  const [input, setInput] = useState("");

  const append = useCallback((next: readonly TranscriptEntry[]) => {
    setTranscript((current) => [...current, ...next]);
  }, []);

  const runSlash = useCallback(
    (command: string): readonly TranscriptEntry[] => {
      const [head] = command.split(/\s+/, 1);
      switch (head) {
        case "/quit":
        case "/exit":
          exit();
          return [{ kind: "info", text: "bye." }];
        case "/help":
          return HELP_LINES.map((text) => ({ kind: "info", text }) as TranscriptEntry);
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
            return [{ kind: "info", text: `reloaded ${storyPaths.length} story file(s)` }];
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return [{ kind: "error", text: `error: ${message}` }];
          }
        }
        default:
          return [{ kind: "error", text: `error: unknown command '${head ?? ""}'` }];
      }
    },
    [exit, model, storyPaths],
  );

  const onSubmit = useCallback(
    (raw: string) => {
      const text = raw.trim();
      setInput("");
      if (text.length === 0) return;
      const echo: TranscriptEntry = { kind: "input", text: `> ${text}` };
      if (text.startsWith("/")) {
        append([echo, ...runSlash(text)]);
        return;
      }
      const entries = handleInput(model, text);
      append([echo, ...entries]);
    },
    [append, model, runSlash],
  );

  return (
    <Box flexDirection="column">
      <Header model={model} storyPaths={storyPaths} />
      <Transcript entries={transcript} />
      <Prompt value={input} onChange={setInput} onSubmit={onSubmit} />
      <Footer />
    </Box>
  );
}

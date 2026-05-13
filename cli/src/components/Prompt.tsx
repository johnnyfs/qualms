import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import { useMemo, useReducer, useEffect } from "react";
import {
  initialInputState,
  inputReducer,
  type InputEvent,
  type InputState,
} from "../play/inputReducer.js";
import type { Suggestion } from "../play/suggest.js";

interface Props {
  readonly mode: "dsl" | "play";
  readonly onSubmit: (text: string) => void;
  readonly onCycleMode: () => void;
  readonly suggest?: (value: string) => readonly Suggestion[];
}

type Reducer = (state: InputState, event: InputEvent) => InputState;

const reducer: Reducer = (state, event) => inputReducer(state, event).state;

export function Prompt({ mode, onSubmit, onCycleMode, suggest }: Props) {
  const [state, dispatch] = useReducer(reducer, initialInputState);

  const suggestions = useMemo<readonly Suggestion[]>(() => {
    if (mode !== "play" || !suggest) return [];
    return suggest(state.value);
  }, [mode, suggest, state.value]);

  useEffect(() => {
    dispatch({ type: "suggestionsChanged", count: suggestions.length });
  }, [suggestions.length]);

  useInput((input, key) => {
    if (key.shift && key.tab) {
      onCycleMode();
      return;
    }
    if (key.tab) {
      if (mode === "play" && suggestions.length > 0) {
        const choice = suggestions[state.selectedSuggestion] ?? suggestions[0];
        if (choice) dispatch({ type: "replace", text: choice.text });
      }
      return;
    }
    if (key.return) {
      const result = inputReducer(state, { type: "submit" });
      if (result.submitted !== undefined) {
        const trimmed = result.submitted.trim();
        if (trimmed.length > 0) onSubmit(result.submitted);
      }
      dispatch({ type: "submit" });
      return;
    }
    if (key.backspace) {
      dispatch({ type: "backspace" });
      return;
    }
    if (key.delete) {
      // Some terminals send `delete` for the keyboard's Backspace key.
      // Use the same behavior as backspace; users without a forward-delete
      // shortcut won't notice the missing forward-delete.
      dispatch({ type: "backspace" });
      return;
    }
    if (key.leftArrow) {
      dispatch({ type: "moveLeft" });
      return;
    }
    if (key.rightArrow) {
      dispatch({ type: "moveRight" });
      return;
    }
    if (key.home) {
      dispatch({ type: "home" });
      return;
    }
    if (key.end) {
      dispatch({ type: "end" });
      return;
    }
    if (key.upArrow) {
      if (mode === "play" && suggestions.length > 0) {
        dispatch({ type: "selectPrev", count: suggestions.length });
      } else {
        dispatch({ type: "historyPrev" });
      }
      return;
    }
    if (key.downArrow) {
      if (mode === "play" && suggestions.length > 0) {
        dispatch({ type: "selectNext", count: suggestions.length });
      } else {
        dispatch({ type: "historyNext" });
      }
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.escape) return;
    if (input) dispatch({ type: "insert", text: input });
  });

  const displayed = renderWithCursor(state.value, state.cursor);
  const modeLabel =
    mode === "play"
      ? "mode: play  (shift+tab → dsl, tab to complete)"
      : "mode: dsl   (shift+tab → play)";

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">{"> "}</Text>
        {displayed}
      </Box>
      {mode === "play" && suggestions.length > 0 ? (
        <Box flexDirection="column" marginLeft={2}>
          {suggestions.slice(0, 5).map((s, i) => (
            <Text
              key={`${s.text}-${i}`}
              bold={i === state.selectedSuggestion}
              dimColor={i !== state.selectedSuggestion}
            >
              {s.text}
            </Text>
          ))}
        </Box>
      ) : null}
      <Text dimColor>{modeLabel}</Text>
    </Box>
  );
}

function renderWithCursor(value: string, cursor: number): ReactElement {
  if (cursor >= value.length) {
    return (
      <>
        <Text>{value}</Text>
        <Text inverse> </Text>
      </>
    );
  }
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);
  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{at}</Text>
      <Text>{after}</Text>
    </>
  );
}

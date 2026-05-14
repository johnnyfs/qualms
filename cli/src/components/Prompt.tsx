import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import { useReducer } from "react";
import {
  initialInputState,
  inputReducer,
  type InputEvent,
  type InputState,
} from "../play/inputReducer.js";

interface Props {
  readonly mode: "dsl" | "play" | "coauthor";
  readonly onSubmit: (text: string) => void;
  readonly onCycleMode: () => void;
  readonly onExit: () => void;
  readonly pendingQuestion?: string | null;
}

type Reducer = (state: InputState, event: InputEvent) => InputState;

const reducer: Reducer = (state, event) => inputReducer(state, event).state;

export function Prompt({ mode, onSubmit, onCycleMode, onExit, pendingQuestion }: Props) {
  const [state, dispatch] = useReducer(reducer, initialInputState);

  useInput((input, key) => {
    if (key.ctrl && input === "d") {
      onExit();
      return;
    }
    if (key.shift && key.tab) {
      onCycleMode();
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
    if (key.backspace || key.delete) {
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
      dispatch({ type: "historyPrev" });
      return;
    }
    if (key.downArrow) {
      dispatch({ type: "historyNext" });
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.escape) return;
    if (input) dispatch({ type: "insert", text: input });
  });

  const displayed = renderWithCursor(state.value, state.cursor);
  const modeLabel =
    mode === "coauthor"
      ? "mode: coauthor (shift+tab → dsl)"
      : "mode: dsl      (shift+tab → play)";

  return (
    <Box flexDirection="column">
      {pendingQuestion ? (
        <Text color="magenta">agent: {pendingQuestion}</Text>
      ) : null}
      <Box>
        <Text color="cyan">{"> "}</Text>
        {displayed}
      </Box>
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

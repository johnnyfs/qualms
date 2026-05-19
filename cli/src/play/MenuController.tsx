import { Box, useInput, useStdout } from "ink";
import { useEffect } from "react";
import type { language } from "@quealm/qualms";
import {
  buildMockupFrame,
  initialMockupMenuState,
  selectMockupOption,
  type MockupMenuState,
} from "./mockupState.js";
import type { PlaySession } from "./runner.js";
import { MessagePanel } from "./MessagePanel.js";
import { MenuPanel } from "./MenuPanel.js";
import { MenuFooter } from "./MenuFooter.js";

export interface PlayUiState {
  readonly menu: MockupMenuState;
  readonly selectedIndex: number;
  readonly lastResult?: language.LanguagePlayResult;
  readonly lastError?: string;
}

export const initialPlayUiState: PlayUiState = {
  menu: initialMockupMenuState,
  selectedIndex: 0,
};

const WINDOW_SIZE = 9;

function clampScrollOffset(selectedIndex: number, total: number): number {
  if (total <= WINDOW_SIZE) return 0;
  const half = Math.floor(WINDOW_SIZE / 2);
  const max = total - WINDOW_SIZE;
  if (selectedIndex <= half) return 0;
  if (selectedIndex >= total - half - 1) return max;
  return selectedIndex - half;
}

interface Props {
  readonly session: PlaySession;
  readonly state: PlayUiState;
  readonly setState: (next: PlayUiState) => void;
  readonly onCycleMode: () => void;
  readonly onExit: () => void;
}

export function MenuController({
  session,
  state,
  setState,
  onCycleMode,
  onExit,
}: Props) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const panelWidth = Math.min(columns - 4, 72);

  const frame = buildMockupFrame(session.model, state.menu);
  const optionCount = frame.options.length;
  const scrollOffset = clampScrollOffset(state.selectedIndex, optionCount);

  useEffect(() => {
    if (state.selectedIndex >= optionCount || state.selectedIndex < 0) {
      setState({ ...state, selectedIndex: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.menu.call.relation, optionCount]);

  useInput((input, key) => {
    if (key.ctrl && input === "d") {
      onExit();
      return;
    }
    if (key.shift && key.tab) {
      onCycleMode();
      return;
    }
    if (key.upArrow) {
      if (optionCount === 0) return;
      const next = (state.selectedIndex - 1 + optionCount) % optionCount;
      setState({ ...state, selectedIndex: next });
      return;
    }
    if (key.downArrow) {
      if (optionCount === 0) return;
      const next = (state.selectedIndex + 1) % optionCount;
      setState({ ...state, selectedIndex: next });
      return;
    }
    if (key.pageUp) {
      if (optionCount === 0) return;
      const next = Math.max(0, state.selectedIndex - WINDOW_SIZE);
      setState({ ...state, selectedIndex: next });
      return;
    }
    if (key.pageDown) {
      if (optionCount === 0) return;
      const next = Math.min(optionCount - 1, state.selectedIndex + WINDOW_SIZE);
      setState({ ...state, selectedIndex: next });
      return;
    }

    const selectIndex = key.return
      ? state.selectedIndex
      : input
        ? digitSelection(input, scrollOffset)
        : undefined;
    if (selectIndex === undefined) return;
    const option = frame.options[selectIndex];
    if (!option) return;
    const transition = selectMockupOption(session.model, option);
    switch (transition.kind) {
      case "state":
        setState({ menu: transition.state, selectedIndex: 0 });
        return;
      case "action":
        setState({
          menu: transition.nextState,
          selectedIndex: 0,
          lastResult: transition.result,
        });
        return;
      case "error":
        setState({
          ...state,
          lastError: transition.message,
        });
        return;
    }
  });

  return (
    <Box flexDirection="column" width={panelWidth}>
      <MessagePanel result={state.lastResult} error={state.lastError} />
      <MenuPanel
        frame={frame}
        selectedIndex={state.selectedIndex}
        scrollOffset={scrollOffset}
        windowSize={WINDOW_SIZE}
      />
      <MenuFooter frame={frame} />
    </Box>
  );
}

function digitSelection(input: string, scrollOffset: number): number | undefined {
  const digit = parseInt(input, 10);
  if (Number.isNaN(digit) || digit < 1 || digit > 9) return undefined;
  return scrollOffset + digit - 1;
}

import { Box, useInput, useStdout } from "ink";
import { useEffect, useMemo } from "react";
import type { language } from "@quealm/qualms";
import type { PlayConfig } from "./config.js";
import type { NameIndex } from "./naming.js";
import type { VerbTable } from "./verbs.js";
import {
  buildFrame,
  initialMenuState,
  selectOption,
  type MenuContext,
  type MenuFrame,
  type MenuOption,
  type MenuState,
  type MenuTransition,
} from "./menuState.js";
import { handleMenuSubmit, type PlaySession } from "./runner.js";
import { RoomPanel } from "./RoomPanel.js";
import { MessagePanel } from "./MessagePanel.js";
import { MenuPanel } from "./MenuPanel.js";
import { MenuFooter } from "./MenuFooter.js";

export interface PlayUiState {
  readonly menu: MenuState;
  readonly selectedIndex: number;
  readonly lastAtom?: language.RelationAtom;
  readonly lastResult?: language.LanguagePlayResult;
  readonly lastQueryResult?: language.LanguageQueryResult;
}

export const initialPlayUiState: PlayUiState = {
  menu: initialMenuState,
  selectedIndex: 0,
};

function menuStateKey(state: MenuState): string {
  switch (state.kind) {
    case "root":
      return "root";
    case "slot":
      return `slot:${state.verb.actionId}:${state.slot}`;
    case "conversation":
      return `conversation:${state.speaker}`;
  }
}

const WINDOW_SIZE = 9;

function clampScrollOffset(selectedIndex: number, total: number): number {
  if (total <= WINDOW_SIZE) return 0;
  // Anchor the selection roughly at the center of the visible window, then
  // clamp so we never scroll past the ends.
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

  const ctx: MenuContext = useMemo(
    () => ({
      model: session.model,
      config: session.config,
      names: session.names,
      verbs: session.verbs,
    }),
    [session.model, session.config, session.names, session.verbs],
  );
  // buildFrame reads the (mutable) model; memoizing on identity would freeze
  // the menu after actions that change the model in place.
  const frame = buildFrame(state.menu, ctx);
  const optionCount = frame.options.length;
  const scrollOffset = clampScrollOffset(state.selectedIndex, optionCount);
  const stateKey = menuStateKey(state.menu);

  // Reset selectedIndex on menu state change; clamp when option list shrinks.
  useEffect(() => {
    if (state.selectedIndex >= optionCount || state.selectedIndex < 0) {
      setState({ ...state, selectedIndex: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey, optionCount]);

  const applyTransition = (transition: MenuTransition) => {
    switch (transition.kind) {
      case "noop":
        return;
      case "state":
        setState({ ...state, menu: transition.state, selectedIndex: 0 });
        return;
      case "submit": {
        const submit = handleMenuSubmit(session, transition.atom);
        setState({
          menu: transition.nextState,
          selectedIndex: 0,
          lastAtom: submit.atom,
          ...(submit.result ? { lastResult: submit.result } : {}),
        });
        return;
      }
      case "query": {
        const submit = handleMenuSubmit(session, transition.atom);
        setState({
          menu: transition.nextState,
          selectedIndex: 0,
          lastAtom: submit.atom,
          ...(submit.queryResult ? { lastQueryResult: submit.queryResult } : {}),
        });
        return;
      }
    }
  };

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
    if (key.return) {
      const option: MenuOption | undefined = frame.options[state.selectedIndex];
      if (!option) return;
      applyTransition(selectOption(state.menu, option, ctx));
      return;
    }
    if (!input) return;
    if (input === "0") {
      const back = frame.backOption;
      if (!back) return;
      applyTransition(selectOption(state.menu, back, ctx));
      return;
    }
    const digit = parseInt(input, 10);
    if (!Number.isNaN(digit) && digit >= 1 && digit <= 9) {
      // Digits map to the currently-visible slice, so position N selects the
      // Nth visible row regardless of scroll offset.
      const optionIndex = scrollOffset + digit - 1;
      const option: MenuOption | undefined = frame.options[optionIndex];
      if (!option) return;
      applyTransition(selectOption(state.menu, option, ctx));
    }
  });

  return (
    <Box flexDirection="column" width={panelWidth}>
      <RoomPanel model={session.model} config={session.config} names={session.names} />
      <MessagePanel
        model={session.model}
        config={session.config}
        names={session.names}
        verbs={session.verbs}
        {...(state.lastAtom ? { atom: state.lastAtom } : {})}
        {...(state.lastResult ? { result: state.lastResult } : {})}
        {...(state.lastQueryResult ? { queryResult: state.lastQueryResult } : {})}
      />
      <MenuPanel
        frame={frame}
        selectedIndex={state.selectedIndex}
        scrollOffset={scrollOffset}
        windowSize={WINDOW_SIZE}
        borderColor={state.menu.kind === "conversation" ? "cyan" : "yellow"}
      />
      <MenuFooter frame={frame} />
    </Box>
  );
}

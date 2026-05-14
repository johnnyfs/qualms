import { Box, useInput } from "ink";
import { useMemo } from "react";
import type { language } from "@quealm/qualms";
import type { PlayConfig } from "./config.js";
import type { NameIndex } from "./naming.js";
import type { VerbTable } from "./verbs.js";
import {
  buildFrame,
  initialMenuState,
  selectOption,
  type MenuContext,
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
  readonly lastAtom?: language.RelationAtom;
  readonly lastResult?: language.LanguagePlayResult;
  readonly lastQueryResult?: language.LanguageQueryResult;
}

export const initialPlayUiState: PlayUiState = { menu: initialMenuState };

interface Props {
  readonly session: PlaySession;
  readonly state: PlayUiState;
  readonly setState: (next: PlayUiState) => void;
  readonly onCycleMode: () => void;
}

export function MenuController({ session, state, setState, onCycleMode }: Props) {
  const ctx: MenuContext = useMemo(
    () => ({
      model: session.model,
      config: session.config,
      names: session.names,
      verbs: session.verbs,
    }),
    [session.model, session.config, session.names, session.verbs],
  );
  const frame = useMemo(() => buildFrame(state.menu, ctx), [state.menu, ctx]);

  const applyTransition = (transition: MenuTransition) => {
    switch (transition.kind) {
      case "noop":
        return;
      case "state":
        setState({ ...state, menu: transition.state });
        return;
      case "submit": {
        const submit = handleMenuSubmit(session, transition.atom);
        setState({
          menu: transition.nextState,
          lastAtom: submit.atom,
          ...(submit.result ? { lastResult: submit.result } : {}),
        });
        return;
      }
      case "query": {
        const submit = handleMenuSubmit(session, transition.atom);
        setState({
          menu: transition.nextState,
          lastAtom: submit.atom,
          ...(submit.queryResult ? { lastQueryResult: submit.queryResult } : {}),
        });
        return;
      }
    }
  };

  useInput((input, key) => {
    if (key.shift && key.tab) {
      onCycleMode();
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
      const option: MenuOption | undefined = frame.options[digit - 1];
      if (!option) return;
      applyTransition(selectOption(state.menu, option, ctx));
    }
  });

  return (
    <Box flexDirection="column">
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
      <MenuPanel frame={frame} />
      <MenuFooter frame={frame} />
    </Box>
  );
}

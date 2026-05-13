export interface InputState {
  readonly value: string;
  readonly cursor: number;
  readonly selectedSuggestion: number;
  readonly history: readonly string[];
  readonly historyIdx: number | null;
}

export const initialInputState: InputState = {
  value: "",
  cursor: 0,
  selectedSuggestion: 0,
  history: [],
  historyIdx: null,
};

export type InputEvent =
  | { readonly type: "insert"; readonly text: string }
  | { readonly type: "backspace" }
  | { readonly type: "delete" }
  | { readonly type: "moveLeft" }
  | { readonly type: "moveRight" }
  | { readonly type: "home" }
  | { readonly type: "end" }
  | { readonly type: "suggestionsChanged"; readonly count: number }
  | { readonly type: "selectPrev"; readonly count: number }
  | { readonly type: "selectNext"; readonly count: number }
  | { readonly type: "replace"; readonly text: string }
  | { readonly type: "submit" }
  | { readonly type: "historyPrev" }
  | { readonly type: "historyNext" };

export interface ReducerResult {
  readonly state: InputState;
  readonly submitted?: string;
}

export function inputReducer(state: InputState, event: InputEvent): ReducerResult {
  switch (event.type) {
    case "insert": {
      const text = event.text;
      const next =
        state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor);
      return {
        state: { ...state, value: next, cursor: state.cursor + text.length, historyIdx: null },
      };
    }
    case "backspace": {
      if (state.cursor === 0) return { state };
      const next = state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor);
      return {
        state: { ...state, value: next, cursor: state.cursor - 1, historyIdx: null },
      };
    }
    case "delete": {
      if (state.cursor >= state.value.length) return { state };
      const next = state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1);
      return { state: { ...state, value: next, historyIdx: null } };
    }
    case "moveLeft": {
      return state.cursor > 0
        ? { state: { ...state, cursor: state.cursor - 1 } }
        : { state };
    }
    case "moveRight": {
      return state.cursor < state.value.length
        ? { state: { ...state, cursor: state.cursor + 1 } }
        : { state };
    }
    case "home":
      return { state: { ...state, cursor: 0 } };
    case "end":
      return { state: { ...state, cursor: state.value.length } };
    case "suggestionsChanged": {
      const next = event.count === 0 ? 0 : Math.min(state.selectedSuggestion, event.count - 1);
      return { state: { ...state, selectedSuggestion: next } };
    }
    case "selectPrev": {
      if (event.count === 0) return { state };
      const next = (state.selectedSuggestion - 1 + event.count) % event.count;
      return { state: { ...state, selectedSuggestion: next } };
    }
    case "selectNext": {
      if (event.count === 0) return { state };
      const next = (state.selectedSuggestion + 1) % event.count;
      return { state: { ...state, selectedSuggestion: next } };
    }
    case "replace": {
      return {
        state: {
          ...state,
          value: event.text,
          cursor: event.text.length,
          selectedSuggestion: 0,
          historyIdx: null,
        },
      };
    }
    case "submit": {
      const trimmed = state.value.trim();
      const history =
        trimmed.length > 0 && state.history[state.history.length - 1] !== trimmed
          ? [...state.history, trimmed]
          : state.history;
      return {
        state: {
          ...state,
          value: "",
          cursor: 0,
          selectedSuggestion: 0,
          history,
          historyIdx: null,
        },
        submitted: state.value,
      };
    }
    case "historyPrev": {
      if (state.history.length === 0) return { state };
      const idx = state.historyIdx === null ? state.history.length - 1 : Math.max(0, state.historyIdx - 1);
      const value = state.history[idx] ?? "";
      return { state: { ...state, value, cursor: value.length, historyIdx: idx } };
    }
    case "historyNext": {
      if (state.historyIdx === null) return { state };
      const idx = state.historyIdx + 1;
      if (idx >= state.history.length) {
        return { state: { ...state, value: "", cursor: 0, historyIdx: null } };
      }
      const value = state.history[idx] ?? "";
      return { state: { ...state, value, cursor: value.length, historyIdx: idx } };
    }
  }
}

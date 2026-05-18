import { language } from "@quealm/qualms";
import type { PlayConfig } from "./config.js";
import type { NameIndex } from "./naming.js";
import type { VerbEntry, VerbTable } from "./verbs.js";
import { currentLocation } from "./resolve.js";
import { titleCase } from "./naming.js";

const { playLanguageQuery } = language;

export interface MenuContext {
  readonly model: language.StoryModel;
  readonly config: PlayConfig;
  readonly names: NameIndex;
  readonly verbs: VerbTable;
}

export type MenuState =
  | { readonly kind: "root" }
  | {
      readonly kind: "slot";
      readonly verb: VerbEntry;
      readonly slot: number; // 0 = first non-actor parameter
      readonly args: readonly language.Term[]; // includes implicit actor at index 0
    }
  | {
      readonly kind: "conversation";
      readonly speaker: string;
    };

export const initialMenuState: MenuState = { kind: "root" };

export type MenuOption =
  | { readonly kind: "verb"; readonly verbId: string; readonly label: string }
  | { readonly kind: "candidate"; readonly id: string; readonly label: string }
  | { readonly kind: "topic"; readonly id: string; readonly label: string }
  | { readonly kind: "switch_topics"; readonly label: string }
  | { readonly kind: "stop_talking"; readonly label: string }
  | { readonly kind: "back"; readonly label: string };

export interface MenuFrame {
  readonly headers: readonly string[]; // first line = bold title; rest = subtitles
  readonly options: readonly MenuOption[]; // numbered 1..N
  readonly backOption?: MenuOption; // shown as 0
}

export type MenuTransition =
  | { readonly kind: "state"; readonly state: MenuState }
  | {
      readonly kind: "submit";
      readonly atom: language.RelationAtom;
      readonly nextState: MenuState;
    }
  | {
      readonly kind: "query";
      readonly atom: language.RelationAtom;
      readonly nextState: MenuState;
    }
  | { readonly kind: "noop" };

export function buildFrame(state: MenuState, ctx: MenuContext): MenuFrame {
  switch (state.kind) {
    case "root":
      return rootFrame(ctx);
    case "slot":
      return slotFrame(state, ctx);
    case "conversation":
      return conversationFrame(state, ctx);
  }
}

export function selectOption(
  state: MenuState,
  option: MenuOption,
  ctx: MenuContext,
): MenuTransition {
  if (option.kind === "back") return back(state);
  if (option.kind === "stop_talking") {
    if (state.kind !== "conversation") return { kind: "noop" };
    const atom: language.RelationAtom = {
      relation: ctx.config.conversation.stopVerb,
      args: [
        { kind: "identifier", id: ctx.config.player },
        { kind: "identifier", id: state.speaker },
      ],
    };
    return { kind: "submit", atom, nextState: { kind: "root" } };
  }
  if (option.kind === "switch_topics") {
    if (state.kind !== "conversation") return { kind: "noop" };
    const atom: language.RelationAtom = {
      relation: ctx.config.conversation.switchVerb,
      args: [
        { kind: "identifier", id: ctx.config.player },
        { kind: "identifier", id: state.speaker },
      ],
    };
    return { kind: "submit", atom, nextState: state };
  }
  if (state.kind === "root" && option.kind === "verb") {
    return selectVerb(option.verbId, ctx);
  }
  if (state.kind === "slot" && option.kind === "candidate") {
    return advanceSlot(state, option.id, ctx);
  }
  if (state.kind === "conversation" && option.kind === "topic") {
    const atom: language.RelationAtom = {
      relation: ctx.config.conversation.navigateVerb,
      args: [
        { kind: "identifier", id: ctx.config.player },
        { kind: "identifier", id: state.speaker },
        { kind: "identifier", id: option.id },
      ],
    };
    return { kind: "submit", atom, nextState: state };
  }
  return { kind: "noop" };
}

export function back(state: MenuState): MenuTransition {
  switch (state.kind) {
    case "root":
      return { kind: "noop" };
    case "slot": {
      if (state.slot === 0) return { kind: "state", state: { kind: "root" } };
      return {
        kind: "state",
        state: {
          kind: "slot",
          verb: state.verb,
          slot: state.slot - 1,
          args: state.args.slice(0, state.args.length - 1),
        },
      };
    }
    case "conversation":
      return { kind: "state", state: { kind: "root" } };
  }
}

function selectVerb(verbId: string, ctx: MenuContext): MenuTransition {
  const verb = ctx.verbs.getById(verbId);
  if (!verb) return { kind: "noop" };
  const actor: language.Term = { kind: "identifier", id: ctx.config.player };
  const args: language.Term[] = [actor];
  if (verb.parameters.length <= 1) {
    const atom: language.RelationAtom = { relation: verb.actionId, args };
    if (verb.kind === "query") {
      return { kind: "query", atom, nextState: { kind: "root" } };
    }
    return { kind: "submit", atom, nextState: { kind: "root" } };
  }
  return {
    kind: "state",
    state: { kind: "slot", verb, slot: 0, args },
  };
}

function advanceSlot(
  state: Extract<MenuState, { kind: "slot" }>,
  pickedId: string,
  ctx: MenuContext,
): MenuTransition {
  const args = [...state.args, { kind: "identifier", id: pickedId } as language.Term];
  const isStartVerb =
    state.verb.actionId === ctx.config.conversation.startVerb;
  const filledSpeaker = isStartVerb && state.slot === 0;
  if (filledSpeaker) {
    // TalkTo only takes (actor, speaker); fire it and slide into the
    // conversation menu in one step.
    const atom: language.RelationAtom = { relation: state.verb.actionId, args };
    return {
      kind: "submit",
      atom,
      nextState: { kind: "conversation", speaker: pickedId },
    };
  }
  // Slot count = parameters - 1 (the implicit actor). slot+1 is the next slot.
  const slotsTotal = state.verb.parameters.length - 1;
  if (state.slot + 1 < slotsTotal) {
    return {
      kind: "state",
      state: { kind: "slot", verb: state.verb, slot: state.slot + 1, args },
    };
  }
  const atom: language.RelationAtom = { relation: state.verb.actionId, args };
  if (state.verb.kind === "query") {
    return { kind: "query", atom, nextState: { kind: "root" } };
  }
  return { kind: "submit", atom, nextState: { kind: "root" } };
}

function slotHeader(
  state: Extract<MenuState, { kind: "slot" }>,
  ctx: MenuContext,
): string {
  const verb = state.verb;
  const parts: string[] = [titleCase(verb.words[0] ?? verb.actionId)];
  // state.args = [actor, ...args filled so far]. state.slot = next slot to fill (0-indexed
  // over non-actor params). For each already-filled slot i in 0..state.slot-1, render its
  // preposition (if any) then "the <name>".
  for (let i = 0; i < state.slot; i++) {
    const prep = verb.prepositions.get(i);
    if (prep) parts.push(prep);
    const arg = state.args[i + 1];
    if (arg && arg.kind === "identifier") {
      parts.push(`the ${ctx.names.displayName(arg.id)}`);
    }
  }
  const currentPrep = verb.prepositions.get(state.slot);
  if (currentPrep) parts.push(currentPrep);
  parts.push("what?");
  return parts.join(" ");
}

function rootFrame(ctx: MenuContext): MenuFrame {
  const options: MenuOption[] = [];
  const conv = ctx.config.conversation;
  const conversationInternal = new Set<string>([
    // Navigation, back-up, and tear-down only make sense mid-conversation.
    conv.navigateVerb,
    conv.switchVerb,
    conv.stopVerb,
    // The conversation queries are read by the menu, not invoked by the player.
    conv.topicsQuery,
    conv.currentTopicQuery,
    conv.previousTopicQuery,
  ]);
  for (const verb of ctx.verbs.all()) {
    if (verb.hidden) continue;
    if (conversationInternal.has(verb.actionId)) continue;
    options.push({
      kind: "verb",
      verbId: verb.actionId,
      label: titleCase(verb.words[0] ?? verb.actionId),
    });
  }
  return { headers: ["What do you do?"], options };
}

function slotFrame(
  state: Extract<MenuState, { kind: "slot" }>,
  ctx: MenuContext,
): MenuFrame {
  const verb = state.verb;
  const headers = [slotHeader(state, ctx)];
  const candidateIds = enumerateCandidates(ctx);
  const options: MenuOption[] = candidateIds.map((id) => ({
    kind: "candidate",
    id,
    label: ctx.names.displayName(id),
  }));
  return {
    headers,
    options,
    backOption: { kind: "back", label: "back" },
  };
}

function conversationFrame(
  state: Extract<MenuState, { kind: "conversation" }>,
  ctx: MenuContext,
): MenuFrame {
  const speakerArgs: readonly language.Term[] = [
    { kind: "identifier", id: ctx.config.player },
    { kind: "identifier", id: state.speaker },
  ];
  const headers = [`Talking to the ${ctx.names.displayName(state.speaker)}.`];
  const currentTopicResult = playLanguageQuery(ctx.model, {
    relation: ctx.config.conversation.currentTopicQuery,
    args: speakerArgs,
  });
  const currentTopicId =
    currentTopicResult.status === "passed" &&
    currentTopicResult.bindings[0]?.topic?.kind === "id"
      ? currentTopicResult.bindings[0].topic.id
      : undefined;
  if (currentTopicId) {
    headers.push(`Currently about ${ctx.names.displayName(currentTopicId)}.`);
  }

  const topicsResult = playLanguageQuery(ctx.model, {
    relation: ctx.config.conversation.topicsQuery,
    args: speakerArgs,
  });
  const topicIds = new Set<string>();
  if (topicsResult.status === "passed") {
    for (const binding of topicsResult.bindings) {
      const t = binding.topic;
      if (t?.kind === "id") topicIds.add(t.id);
    }
  }
  const options: MenuOption[] = [...topicIds]
    .sort((a, b) => ctx.names.displayName(a).localeCompare(ctx.names.displayName(b)))
    .map((id) => ({
      kind: "topic",
      id,
      label: ctx.names.displayName(id),
    }));

  // Probe history: if the player has a previous topic to back up to, the
  // back option is "change topics" (SwitchTopics); otherwise we're at the
  // root of the conversation tree and the only way out is "leave"
  // (StopTalking).
  const previousResult = playLanguageQuery(ctx.model, {
    relation: ctx.config.conversation.previousTopicQuery,
    args: speakerArgs,
  });
  const hasPrevious =
    previousResult.status === "passed" && previousResult.bindings.length > 0;
  const backOption: MenuOption = hasPrevious
    ? { kind: "switch_topics", label: "change topics" }
    : { kind: "stop_talking", label: "leave" };

  return { headers, options, backOption };
}

function enumerateCandidates(ctx: MenuContext): readonly string[] {
  // Opportunistic: call Visible(player) and let the DSL reject domain-invalid picks.
  const result = playLanguageQuery(ctx.model, {
    relation: "Visible",
    args: [{ kind: "identifier", id: ctx.config.player }],
  });
  const here = currentLocation(ctx.model, ctx.config);
  const seen = new Set<string>();
  const ordered: string[] = [];
  if (result.status === "passed") {
    for (const binding of result.bindings) {
      const t = binding.target;
      if (t?.kind !== "id") continue;
      if (t.id === ctx.config.player) continue;
      if (here !== undefined && t.id === here) continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      ordered.push(t.id);
    }
  }
  ordered.sort((a, b) => ctx.names.displayName(a).localeCompare(ctx.names.displayName(b)));
  return ordered;
}

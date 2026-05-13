import type { TranscriptEntry } from "../types.js";
import { currentLocation, visibleEntities } from "./resolve.js";
import { formatResult } from "./resultFormatter.js";
import type { View, ViewContext } from "./view.js";

const BLANK: TranscriptEntry = { kind: "narrative", text: "" };

export const infocomView: View = {
  id: "infocom",
  renderTurn(ctx: ViewContext): readonly TranscriptEntry[] {
    const out: TranscriptEntry[] = [];

    if (ctx.lastAtom && (ctx.lastResult || ctx.lastQueryResult)) {
      const line = formatResult(ctx.lastAtom, {
        config: ctx.config,
        names: ctx.names,
        verbs: ctx.verbs,
        model: ctx.model,
        result: ctx.lastResult,
        queryResult: ctx.lastQueryResult,
      });
      const failed =
        (ctx.lastResult && ctx.lastResult.status !== "passed") ||
        (ctx.lastQueryResult && ctx.lastQueryResult.status !== "passed");
      out.push({
        kind: failed ? "error" : "narrative",
        text: line,
      });
    } else if (ctx.lastError) {
      out.push({ kind: "error", text: ctx.lastError });
    }

    const location = currentLocation(ctx.model, ctx.config);
    if (!location) {
      out.push({
        kind: "error",
        text: `(no location: ${ctx.config.player} has no ${ctx.config.visibility.locationFact} fact)`,
      });
      return out;
    }

    out.push(BLANK);
    out.push({ kind: "title", text: ctx.names.titleName(location) });
    out.push(BLANK);

    const desc = ctx.config.descriptions.get(location);
    if (desc) {
      out.push({ kind: "narrative", text: desc });
      out.push(BLANK);
    }

    const visible = visibleEntities(ctx.model, ctx.config);
    const presentations: string[] = [];
    for (const id of visible.ids) {
      if (id === location) continue;
      const presentation = ctx.config.presentations.get(id);
      if (presentation) presentations.push(presentation);
    }
    for (let i = 0; i < presentations.length; i++) {
      out.push({ kind: "narrative", text: presentations[i]! });
      if (i < presentations.length - 1) out.push(BLANK);
    }

    return out;
  },
};

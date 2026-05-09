/**
 * Transaction model for the structural mutation tools.
 *
 * NOTE: this snapshot-based implementation is provisional for the mutation-tools
 * milestone. `__begin` deep-clones the GameDefinition + WorldState so rollback
 * can restore them; cost scales with world size, not transaction size, and
 * forecloses parallel transactions across scopes. The intended endpoint is a
 * functional amend layer (base ref + delta merged on read). When that lands,
 * replace the `clone()` calls here together with the matching `clone()` methods
 * on `GameDefinition` and `WorldState`.
 */

import { GameDefinition } from "../core/definition.js";
import { WorldState } from "../core/worldState.js";
import type { Layer } from "../core/types.js";
import type { MutationStatement } from "../query/ast.js";

export type Scope = "story" | "session";

export interface BeginOptions {
  id: string;
  scope: Scope;
  def: GameDefinition;
  state: WorldState;
  /** Story-scope only: target YAML file path for the eventual __commit. */
  targetPath?: string;
}

/**
 * One open structural transaction. Holds:
 *   - the resolved layer (story → game, session → session)
 *   - pre-mutation snapshots of the def + state for rollback
 *   - an append-only log of mutations applied (for `__diff` and the YAML emit step).
 */
export interface Transaction {
  readonly id: string;
  readonly scope: Scope;
  readonly layer: Layer;
  readonly applied: MutationStatement[];
  readonly defSnapshot: GameDefinition;
  readonly stateSnapshot: WorldState;
  readonly targetPath?: string;
}

function scopeToLayer(scope: Scope): Layer {
  return scope === "story" ? "game" : "session";
}

export const Transaction = {
  begin(options: BeginOptions): Transaction {
    const defSnapshot = options.def.clone();
    const stateSnapshot = options.state.clone(defSnapshot);
    return {
      id: options.id,
      scope: options.scope,
      layer: scopeToLayer(options.scope),
      applied: [],
      defSnapshot,
      stateSnapshot,
      ...(options.targetPath !== undefined ? { targetPath: options.targetPath } : {}),
    };
  },

  /**
   * Restore the def + state to their pre-transaction snapshots. Returns the
   * fresh def/state for the caller to swap into its session record.
   */
  rollback(tx: Transaction): { def: GameDefinition; state: WorldState } {
    const def = tx.defSnapshot.clone();
    const state = tx.stateSnapshot.clone(def);
    return { def, state };
  },
};

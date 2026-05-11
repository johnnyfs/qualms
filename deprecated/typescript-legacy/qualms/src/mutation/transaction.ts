/**
 * Transaction model for the structural mutation tools.
 *
 * NOTE: this snapshot-based implementation is provisional for the mutation-tools
 * milestone. `begin` deep-clones the GameDefinition + WorldState so rollback
 * can restore them; cost scales with world size, not transaction size, and
 * forecloses parallel transactions across modules. The intended endpoint is a
 * functional amend layer (base ref + delta merged on read). When that lands,
 * replace the `clone()` calls here together with the matching `clone()` methods
 * on `GameDefinition` and `WorldState`.
 */

import { GameDefinition } from "../core/definition.js";
import { WorldState } from "../core/worldState.js";
import type { Module } from "../core/types.js";
import type { MutationStatement } from "../query/ast.js";

/** Modules a transaction can write to. `prelude` is read-only and rejected upstream. */
export type WritableModule = Exclude<Module, "prelude">;

export interface BeginOptions {
  id: string;
  module: WritableModule;
  def: GameDefinition;
  state: WorldState;
  /** Game-module only: target YAML file path for the eventual `commit`. */
  targetPath?: string;
}

/**
 * One open structural transaction. Holds:
 *   - the target module (mutations land at this layer)
 *   - pre-mutation snapshots of the def + state for rollback
 *   - an append-only log of mutations applied (for `diff` and the YAML emit step).
 */
export interface Transaction {
  readonly id: string;
  readonly module: WritableModule;
  readonly applied: MutationStatement[];
  readonly defSnapshot: GameDefinition;
  readonly stateSnapshot: WorldState;
  readonly targetPath?: string;
}

export const Transaction = {
  begin(options: BeginOptions): Transaction {
    const defSnapshot = options.def.clone();
    const stateSnapshot = options.state.clone(defSnapshot);
    return {
      id: options.id,
      module: options.module,
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

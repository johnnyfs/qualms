/**
 * In-process session manager. Each session holds a loaded GameDefinition,
 * a live WorldState, and (when one is open) a structural Transaction.
 * Sessions are addressed by an opaque id that the agent passes back on every
 * tool call.
 *
 * Transaction policy: one open transaction per session at a time (per
 * MIGRATION.md). Mutation tools (`__mutate`, `__diff`, `__commit`, `__rollback`)
 * require an open transaction; `__begin` opens one and rejects if one is
 * already open.
 */

import { randomUUID } from "node:crypto";
import {
  GameDefinition,
  type Layer,
  WorldState,
  instantiate,
  mutation as mutationNs,
  query as queryNs,
  yaml as yamlNs,
} from "@quealm/qualms";

type MutationStatement = queryNs.MutationStatement;

const { loadFileIntoDefinition } = yamlNs;
const { Transaction, applyMutation } = mutationNs;
type Transaction = ReturnType<typeof Transaction.begin>;
type Scope = Transaction["scope"];

export interface SessionStartOptions {
  corePath: string;
  storyPaths?: string[];
}

/** Session record. `definition` and `state` are mutable so __rollback can swap snapshots. */
export interface Session {
  readonly id: string;
  definition: GameDefinition;
  state: WorldState;
  readonly corePath: string;
  readonly storyPaths: readonly string[];
  transaction: Transaction | null;
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session '${sessionId}' not found`);
    this.name = "SessionNotFoundError";
  }
}

export class TransactionNotFoundError extends Error {
  constructor(sessionId: string, transactionId?: string) {
    super(
      transactionId
        ? `session '${sessionId}' has no open transaction with id '${transactionId}'`
        : `session '${sessionId}' has no open transaction`,
    );
    this.name = "TransactionNotFoundError";
  }
}

export class TransactionAlreadyOpenError extends Error {
  constructor(sessionId: string) {
    super(
      `session '${sessionId}' already has an open transaction (one transaction per session)`,
    );
    this.name = "TransactionAlreadyOpenError";
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  start(options: SessionStartOptions): Session {
    const def = new GameDefinition();
    loadFileIntoDefinition(def, options.corePath, "prelude" satisfies Layer);
    for (const storyPath of options.storyPaths ?? []) {
      loadFileIntoDefinition(def, storyPath, "game" satisfies Layer);
    }
    const state = instantiate(def);
    const session: Session = {
      id: randomUUID(),
      definition: def,
      state,
      corePath: options.corePath,
      storyPaths: options.storyPaths ?? [],
      transaction: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new SessionNotFoundError(sessionId);
    return s;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  quit(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  size(): number {
    return this.sessions.size;
  }

  listIds(): string[] {
    return [...this.sessions.keys()];
  }

  // ──────── Transactions ────────

  /** Open a structural transaction. Throws if one is already open. */
  beginTransaction(sessionId: string, scope: Scope, targetPath?: string): Transaction {
    const s = this.get(sessionId);
    if (s.transaction !== null) {
      throw new TransactionAlreadyOpenError(sessionId);
    }
    const tx = Transaction.begin({
      id: randomUUID(),
      scope,
      def: s.definition,
      state: s.state,
      ...(targetPath !== undefined ? { targetPath } : {}),
    });
    s.transaction = tx;
    return tx;
  }

  /** Apply a parsed mutation to the open transaction. Throws if no transaction is open. */
  applyMutationToOpenTransaction(
    sessionId: string,
    transactionId: string,
    m: MutationStatement,
  ): void {
    const s = this.get(sessionId);
    const tx = s.transaction;
    if (tx === null) throw new TransactionNotFoundError(sessionId);
    if (tx.id !== transactionId) throw new TransactionNotFoundError(sessionId, transactionId);
    applyMutation(m, tx, s.definition, s.state);
  }

  /** Get the open transaction or throw. */
  requireTransaction(sessionId: string, transactionId: string): {
    session: Session;
    transaction: Transaction;
  } {
    const session = this.get(sessionId);
    const tx = session.transaction;
    if (tx === null) throw new TransactionNotFoundError(sessionId);
    if (tx.id !== transactionId) {
      throw new TransactionNotFoundError(sessionId, transactionId);
    }
    return { session, transaction: tx };
  }

  /** Discard the open transaction's changes; restore def + state from its snapshot. */
  rollback(sessionId: string, transactionId: string): { discarded: number } {
    const { session, transaction } = this.requireTransaction(sessionId, transactionId);
    const restored = Transaction.rollback(transaction);
    session.definition = restored.def;
    session.state = restored.state;
    const count = transaction.applied.length;
    session.transaction = null;
    return { discarded: count };
  }

  /** Drop the snapshot; the live def + state already reflect the committed changes. */
  commit(sessionId: string, transactionId: string): { committed: number; transaction: Transaction } {
    const { session, transaction } = this.requireTransaction(sessionId, transactionId);
    const committed = transaction.applied.length;
    session.transaction = null;
    return { committed, transaction };
  }
}

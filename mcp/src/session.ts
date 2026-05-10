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
import { readFileSync } from "node:fs";
import {
  GameDefinition,
  type Module,
  WorldState,
  dsl as dslNs,
  instantiate,
  language as languageNs,
  mutation as mutationNs,
  query as queryNs,
} from "@quealm/qualms";

type MutationStatement = queryNs.MutationStatement;

const { loadDslFile } = dslNs;
const { Transaction, applyMutation } = mutationNs;
type Transaction = ReturnType<typeof Transaction.begin>;
type WritableModule = Transaction["module"];

export interface SessionStartOptions {
  corePath?: string;
  storyPaths?: string[];
}

export interface LegacySession {
  readonly id: string;
  readonly mode: "legacy";
  definition: GameDefinition;
  state: WorldState;
  readonly corePath: string;
  readonly storyPaths: readonly string[];
  transaction: Transaction | null;
}

export interface LanguageSession {
  readonly id: string;
  readonly mode: "language";
  readonly languageModel: languageNs.StoryModel;
  readonly storyPaths: readonly string[];
  transaction: null;
}

/** Session record. Legacy `definition` and `state` are mutable so __rollback can swap snapshots. */
export type Session = LegacySession | LanguageSession;

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
    if (options.corePath === undefined) {
      const languageModel = new languageNs.StoryModel();
      for (const storyPath of options.storyPaths ?? []) {
        languageModel.apply(languageNs.parseProgram(readFileSync(storyPath, "utf-8")));
      }
      const session: LanguageSession = {
        id: randomUUID(),
        mode: "language",
        languageModel,
        storyPaths: options.storyPaths ?? [],
        transaction: null,
      };
      this.sessions.set(session.id, session);
      return session;
    }

    const def = new GameDefinition();
    loadDslFile(def, options.corePath, "prelude" satisfies Module);
    for (const storyPath of options.storyPaths ?? []) {
      loadDslFile(def, storyPath, "game" satisfies Module);
    }
    const state = instantiate(def);
    const session: LegacySession = {
      id: randomUUID(),
      mode: "legacy",
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
  beginTransaction(sessionId: string, module: WritableModule, targetPath?: string): Transaction {
    const s = this.get(sessionId);
    if (s.mode !== "legacy") {
      throw new TransactionNotFoundError(sessionId);
    }
    if (s.transaction !== null) {
      throw new TransactionAlreadyOpenError(sessionId);
    }
    const tx = Transaction.begin({
      id: randomUUID(),
      module,
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
    if (s.mode !== "legacy") throw new TransactionNotFoundError(sessionId);
    const tx = s.transaction;
    if (tx === null) throw new TransactionNotFoundError(sessionId);
    if (tx.id !== transactionId) throw new TransactionNotFoundError(sessionId, transactionId);
    applyMutation(m, tx, s.definition, s.state);
  }

  /** Get the open transaction or throw. */
  requireTransaction(sessionId: string, transactionId: string): {
    session: LegacySession;
    transaction: Transaction;
  } {
    const session = this.get(sessionId);
    if (session.mode !== "legacy") throw new TransactionNotFoundError(sessionId);
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

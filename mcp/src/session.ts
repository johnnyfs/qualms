import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { language as languageNs } from "@quealm/qualms";

export interface SessionStartOptions {
  storyPaths?: string[];
}

export interface LanguageTransaction {
  readonly id: string;
  readonly snapshot: languageNs.StoryModel;
  readonly applied: string[];
  readonly targetPath?: string;
}

export interface Session {
  readonly id: string;
  model: languageNs.StoryModel;
  readonly storyPaths: readonly string[];
  transaction: LanguageTransaction | null;
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
    super(`session '${sessionId}' already has an open transaction`);
    this.name = "TransactionAlreadyOpenError";
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  start(options: SessionStartOptions = {}): Session {
    const model = new languageNs.StoryModel();
    for (const storyPath of options.storyPaths ?? []) {
      model.apply(languageNs.parseProgram(readFileSync(storyPath, "utf-8")));
    }
    const session: Session = {
      id: randomUUID(),
      model,
      storyPaths: options.storyPaths ?? [],
      transaction: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
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

  beginTransaction(sessionId: string, targetPath?: string): LanguageTransaction {
    const session = this.get(sessionId);
    if (session.transaction) throw new TransactionAlreadyOpenError(sessionId);
    const resolvedTargetPath = targetPath ?? inferTargetPath(session.storyPaths);
    const transaction: LanguageTransaction = {
      id: randomUUID(),
      snapshot: session.model.clone(),
      applied: [],
      ...(resolvedTargetPath ? { targetPath: resolvedTargetPath } : {}),
    };
    session.transaction = transaction;
    return transaction;
  }

  requireTransaction(
    sessionId: string,
    transactionId: string,
  ): { session: Session; transaction: LanguageTransaction } {
    const session = this.get(sessionId);
    const transaction = session.transaction;
    if (!transaction) throw new TransactionNotFoundError(sessionId);
    if (transaction.id !== transactionId) {
      throw new TransactionNotFoundError(sessionId, transactionId);
    }
    return { session, transaction };
  }

  applyToTransaction(sessionId: string, transactionId: string, source: string): void {
    const { session, transaction } = this.requireTransaction(sessionId, transactionId);
    session.model.apply(languageNs.parseProgram(source));
    transaction.applied.push(source);
  }

  rollback(sessionId: string, transactionId: string): { discarded: number } {
    const { session, transaction } = this.requireTransaction(sessionId, transactionId);
    const discarded = transaction.applied.length;
    session.model = transaction.snapshot.clone();
    session.transaction = null;
    return { discarded };
  }

  commit(sessionId: string, transactionId: string): { committed: number; transaction: LanguageTransaction } {
    const { session, transaction } = this.requireTransaction(sessionId, transactionId);
    const committed = transaction.applied.length;
    session.transaction = null;
    return { committed, transaction };
  }
}

function inferTargetPath(storyPaths: readonly string[]): string | undefined {
  return storyPaths.length === 1 ? storyPaths[0] : undefined;
}

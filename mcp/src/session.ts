/**
 * In-process session manager. Each session holds a loaded GameDefinition and
 * a live WorldState; sessions are addressed by an opaque id that the agent
 * passes back on every tool call.
 *
 * For step 5 we expose start/quit/query — no transactions, no mutations,
 * no save. Sessions live for the lifetime of the server process.
 */

import { randomUUID } from "node:crypto";
import {
  GameDefinition,
  type Layer,
  WorldState,
  instantiate,
  yaml as yamlNs,
} from "@quealm/qualms";

const { loadFileIntoDefinition } = yamlNs;

export interface SessionStartOptions {
  corePath: string;
  storyPaths?: string[];
}

export interface Session {
  readonly id: string;
  readonly definition: GameDefinition;
  readonly state: WorldState;
  readonly corePath: string;
  readonly storyPaths: readonly string[];
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session '${sessionId}' not found`);
    this.name = "SessionNotFoundError";
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
}

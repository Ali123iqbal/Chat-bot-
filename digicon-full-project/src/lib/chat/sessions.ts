import { randomUUID } from "node:crypto";
import type { Intent } from "./intent";

export interface SessionState {
  lastIntent: Intent | null;
  lastMemberId: string | null;
  pending: { intent: Intent; candidateIds: string[] } | null;
}

interface Entry {
  userId: string;
  lastSeen: number;
  state: SessionState;
}

const newState = (): SessionState => ({ lastIntent: null, lastMemberId: null, pending: null });

/**
 * In-memory conversation store. Every conversation is bound to the signed-in user;
 * a different user gets the same answer as for an unknown ID (no existence leak).
 * Swap for Redis/DB in a multi-instance deployment.
 */
export class SessionStore {
  private map = new Map<string, Entry>();
  constructor(
    private idleMs = (Number(process.env.DIGICON_IDLE_MINUTES) || 30) * 60_000,
    private now: () => number = Date.now,
  ) {}

  private sweep() {
    const t = this.now();
    for (const [id, e] of this.map) if (t - e.lastSeen > this.idleMs) this.map.delete(id);
  }

  start(userId: string): string {
    this.sweep();
    const id = randomUUID();
    this.map.set(id, { userId, lastSeen: this.now(), state: newState() });
    return id;
  }

  /** Returns state only for the owner and only while not idle-expired. */
  get(id: string, userId: string): SessionState | null {
    this.sweep();
    const e = this.map.get(id);
    if (!e || e.userId !== userId) return null;
    e.lastSeen = this.now();
    return e.state;
  }

  end(id: string, userId: string): boolean {
    const e = this.map.get(id);
    if (!e || e.userId !== userId) return false;
    return this.map.delete(id);
  }

  endAllFor(userId: string) {
    for (const [id, e] of this.map) if (e.userId === userId) this.map.delete(id);
  }
}

export function getSessions(): SessionStore {
  const g = globalThis as unknown as { __digiconSessions?: SessionStore };
  return (g.__digiconSessions ??= new SessionStore());
}

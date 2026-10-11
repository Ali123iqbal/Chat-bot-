import { DEPARTMENTS, type Day } from "../types";
import type { Intent } from "../chat/intent";

/**
 * Optional AI adapter. OFF by default (NoopInterpreter).
 *
 * Contract:
 *  - It receives ONLY the question text. Never member records, names or IDs from the dataset.
 *  - It returns an UNTRUSTED object. `validateIntent` checks it against the allow-list below
 *    before any search runs, so a model can never trigger anything but the existing searches.
 *  - Provider keys belong on the server only. Agree provider and monthly budget before enabling.
 */
export interface IntentInterpreter {
  interpret(question: string): Promise<unknown | null>;
}

export class NoopInterpreter implements IntentInterpreter {
  async interpret(): Promise<null> {
    return null;
  }
}

/** Hard monthly request cap. Wrap any paid provider with this before enabling it. */
export class CappedInterpreter implements IntentInterpreter {
  private month = "";
  private used = 0;
  constructor(
    private readonly inner: IntentInterpreter,
    private readonly maxPerMonth: number,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async interpret(question: string): Promise<unknown | null> {
    const key = this.now().toISOString().slice(0, 7);
    if (key !== this.month) { this.month = key; this.used = 0; }
    if (this.used >= this.maxPerMonth) return null;
    this.used += 1;
    return this.inner.interpret(question);
  }
}

const DAYS: Day[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const str = (v: unknown, max = 100): string | null =>
  typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null;
const dept = (v: unknown) => (DEPARTMENTS as readonly string[]).includes(v as string) ? (v as (typeof DEPARTMENTS)[number]) : null;

/** Allow-list: anything not matching exactly one known intent shape is rejected. Extra fields are dropped. */
export function validateIntent(raw: unknown): Intent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  switch (o.type) {
    case "find": { const q = str(o.query); return q ? { type: "find", query: q } : null; }
    case "commute": { const q = str(o.query); return q ? { type: "commute", query: q } : null; }
    case "countDepts": return { type: "countDepts" };
    case "listDept": { const d = dept(o.dept); return d ? { type: "listDept", dept: d, page: 1 } : null; }
    case "noClass": {
      const d = o.dept == null ? null : dept(o.dept);
      if (o.dept != null && !d) return null;
      if (typeof o.day !== "string" || !DAYS.includes(o.day as Day)) return null;
      if (typeof o.slot !== "number" || !Number.isInteger(o.slot) || o.slot < 1 || o.slot > 4) return null;
      return { type: "noClass", dept: d, day: o.day as Day, slot: o.slot, page: 1 };
    }
    case "stay": {
      const d = o.dept == null ? null : dept(o.dept);
      if (o.dept != null && !d) return null;
      if (typeof o.time !== "string" || !TIME.test(o.time)) return null;
      return { type: "stay", dept: d, time: o.time, page: 1 };
    }
    default: return null;
  }
}

export function getInterpreter(): IntentInterpreter {
  const g = globalThis as unknown as { __digiconAi?: IntentInterpreter };
  return (g.__digiconAi ??= new NoopInterpreter());
}
export function setInterpreter(i: IntentInterpreter | null) {
  (globalThis as unknown as { __digiconAi?: IntentInterpreter | undefined }).__digiconAi = i ?? undefined;
}

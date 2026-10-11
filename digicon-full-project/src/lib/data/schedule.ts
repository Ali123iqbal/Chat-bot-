import { GROUP_SLOTS, type Day, type GroupKey, type GroupSchedule, type Schedule } from "../types";

export const DAY_TO_GROUP: Partial<Record<Day, GroupKey>> = {
  monday: "monWed",
  wednesday: "monWed",
  tuesday: "tueThu",
  thursday: "tueThu",
  saturday: "sat",
  sunday: "sun",
};

export function emptySchedule(): Schedule {
  const g = (): GroupSchedule => ({ answered: false, occupiedSlots: [] });
  return { monWed: g(), tueThu: g(), sat: g(), sun: g() };
}

export type ScheduleParse =
  | { ok: true; value: GroupSchedule }
  | { ok: false; error: string };

/**
 * Cell grammar:
 *   ""                -> answered=false (never inferred)
 *   "No classes"      -> answered=true, occupied=[]
 *   "1,3" / "1; 3"    -> answered=true, occupied=[1,3]
 */
export function parseScheduleCell(cell: string, group: GroupKey): ScheduleParse {
  const t = cell.trim();
  if (t === "") return { ok: true, value: { answered: false, occupiedSlots: [] } };
  if (/^(no\s+classes?|none|n\/a)$/i.test(t)) {
    return { ok: true, value: { answered: true, occupiedSlots: [] } };
  }
  const max = GROUP_SLOTS[group];
  const slots = new Set<number>();
  for (const part of t.split(/[,;]+/)) {
    const p = part.trim();
    if (!/^\d+$/.test(p)) return { ok: false, error: `"${t}" is not a list of slot numbers or "No classes"` };
    const n = Number(p);
    if (n < 1 || n > max) return { ok: false, error: `slot ${n} is outside 1-${max}` };
    slots.add(n);
  }
  return { ok: true, value: { answered: true, occupiedSlots: [...slots].sort((a, b) => a - b) } };
}

export type SlotState = "class" | "no_class" | "unknown";

/** Only a confirmed no-class slot is "no_class". Unanswered groups are unknown. */
export function slotState(s: GroupSchedule, slot: number): SlotState {
  if (!s.answered) return "unknown";
  return s.occupiedSlots.includes(slot) ? "class" : "no_class";
}

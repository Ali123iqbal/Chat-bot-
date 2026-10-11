import { normalizeText } from "../data/departments";
import { DAY_TO_GROUP, slotState } from "../data/schedule";
import { canStayUntil, type StayVerdict } from "../data/lateStay";
import { DEPARTMENTS, GROUP_SLOTS, type Day, type Department, type Member, type Outcome, type Page } from "../types";

export const MAX_PAGE_SIZE = 10;

function paginate<T>(all: T[], page = 1, pageSize = MAX_PAGE_SIZE): Page<T> {
  const size = Math.min(Math.max(1, Math.floor(pageSize)), MAX_PAGE_SIZE);
  const p = Math.max(1, Math.floor(page));
  return { items: all.slice((p - 1) * size, p * size), total: all.length, page: p, pageSize: size };
}
const byName = (a: Member, b: Member) => a.fullName.localeCompare(b.fullName);

/** Search by student ID (exact) or by name (token match). Multiple results => caller must disambiguate. */
export function findMembers(members: Member[], query: string): Outcome<Member[]> {
  const q = query.trim();
  if (!q || q.length > 100) return { kind: "error", message: "Invalid search text." };
  const byId = members.filter((m) => m.studentId === q);
  if (byId.length) return { kind: "ok", data: byId };

  const norm = normalizeText(q);
  const exact = members.filter((m) => normalizeText(m.fullName) === norm);
  if (exact.length) return { kind: "ok", data: exact.sort(byName) };

  const tokens = norm.split(" ").filter(Boolean);
  if (!tokens.length) return { kind: "no_match" };
  const hits = members.filter((m) => {
    const nameTokens = normalizeText(m.fullName).split(" ");
    return tokens.every((t) => nameTokens.some((nt) => nt === t || (t.length >= 3 && nt.startsWith(t))));
  });
  return hits.length ? { kind: "ok", data: hits.sort(byName) } : { kind: "no_match" };
}

export function listByDepartment(members: Member[], dept: Department, page = 1): Outcome<Page<Member>> {
  const all = members.filter((m) => m.department === dept).sort(byName);
  return all.length ? { kind: "ok", data: paginate(all, page) } : { kind: "no_match" };
}

/** Counts are computed over ALL members, never over a page. */
export function countByDepartment(members: Member[]): { counts: Record<Department, number>; total: number } {
  const counts = Object.fromEntries(DEPARTMENTS.map((d) => [d, 0])) as Record<Department, number>;
  for (const m of members) counts[m.department] += 1;
  return { counts, total: members.length };
}

export interface NoClassResult {
  day: Day;
  slot: number;
  department: Department | null;
  confirmed: Page<Member>;
  hasClassCount: number;
  unknown: Member[];
  totalInScope: number;
}

/** Only confirmed no-class slots match. Unknown schedules are reported separately. */
export function findNoClass(
  members: Member[],
  q: { day: Day; slot: number; department?: Department | null; page?: number },
): Outcome<NoClassResult> {
  const group = DAY_TO_GROUP[q.day];
  if (!group) return { kind: "error", message: `No timetable is recorded for ${cap(q.day)}.` };
  if (!Number.isInteger(q.slot) || q.slot < 1 || q.slot > GROUP_SLOTS[group]) {
    return { kind: "error", message: `${cap(q.day)} has slots 1-${GROUP_SLOTS[group]}.` };
  }
  const scope = members.filter((m) => !q.department || m.department === q.department);
  if (!scope.length) return { kind: "no_match" };
  const confirmed: Member[] = [];
  const unknown: Member[] = [];
  let hasClass = 0;
  for (const m of scope) {
    const s = slotState(m.schedule[group], q.slot);
    if (s === "no_class") confirmed.push(m);
    else if (s === "unknown") unknown.push(m);
    else hasClass += 1;
  }
  confirmed.sort(byName);
  unknown.sort(byName);
  return {
    kind: "ok",
    data: {
      day: q.day, slot: q.slot, department: q.department ?? null,
      confirmed: paginate(confirmed, q.page), hasClassCount: hasClass, unknown, totalInScope: scope.length,
    },
  };
}

export interface StayResult {
  time: string;
  department: Department | null;
  yes: Page<Member>;
  conditional: Member[];
  no: number;
  unknown: Member[];
  totalInScope: number;
}

export function findCanStay(
  members: Member[],
  q: { time: string; department?: Department | null; page?: number },
): Outcome<StayResult> {
  if (!/^\d{2}:\d{2}$/.test(q.time)) return { kind: "error", message: "Invalid time." };
  const scope = members.filter((m) => !q.department || m.department === q.department);
  if (!scope.length) return { kind: "no_match" };
  const buckets: Record<StayVerdict, Member[]> = { yes: [], conditional: [], no: [], unknown: [] };
  for (const m of scope) buckets[canStayUntil(m.lateStay, q.time)].push(m);
  for (const k of Object.keys(buckets) as StayVerdict[]) buckets[k].sort(byName);
  return {
    kind: "ok",
    data: {
      time: q.time, department: q.department ?? null,
      yes: paginate(buckets.yes, q.page), conditional: buckets.conditional, no: buckets.no.length,
      unknown: buckets.unknown, totalInScope: scope.length,
    },
  };
}

function cap(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

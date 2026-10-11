import { findDepartmentInText } from "../data/departments";
import { parseTime } from "../data/lateStay";
import type { Day, Department } from "../types";

export type Intent =
  | { type: "find"; query: string }
  | { type: "listDept"; dept: Department; page: number }
  | { type: "countDepts" }
  | { type: "noClass"; dept: Department | null; day: Day | null; slot: number | null; page: number }
  | { type: "stay"; dept: Department | null; time: string | null; timeUnclear?: boolean; page: number }
  | { type: "commute"; query: string }
  | { type: "more" }
  | { type: "help" }
  | { type: "unknown" };

export const LAST_MEMBER = "@last";
const ID_RE = /\b\d{4,6}-\d{3,6}\b/;

const DAYS: [RegExp, Day][] = [
  [/\bmon(day)?\b/, "monday"], [/\btue(s|sday)?\b/, "tuesday"], [/\bwed(nesday)?\b/, "wednesday"],
  [/\bthu(r|rs|rsday)?\b/, "thursday"], [/\bfri(day)?\b/, "friday"], [/\bsat(urday)?\b/, "saturday"],
  [/\bsun(day)?\b/, "sunday"],
];
const ORDINALS: Record<string, number> = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4 };

export function extractDay(t: string): Day | null {
  for (const [re, d] of DAYS) if (re.test(t)) return d;
  return null;
}
export function extractSlot(t: string): number | null {
  const a = t.match(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+(slot|class|period)/);
  if (a) return ORDINALS[a[1]!]!;
  const b = t.match(/\b(slot|period)\s*#?\s*(\d)\b/);
  if (b) return Number(b[2]);
  const c = t.match(/^\s*(?:and\s+|what about\s+)?(?:the\s+)?(first|second|third|fourth|1st|2nd|3rd|4th)(?:\s+one)?\s*\??\s*$/);
  if (c) return ORDINALS[c[1]!]!;
  return null;
}
/** Returns {time} when unambiguous, {unclear:true} for a bare "5" that could be am/pm. */
export function extractTime(t: string): { time: string | null; unclear: boolean } {
  const m = t.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/) ?? t.match(/\b([01]?\d:[0-5]\d|2[0-3]:[0-5]\d)\b/);
  if (m) return { time: parseTime(m[1]!), unclear: false };
  const bare = t.match(/\b(?:until|till|til|past|after|by)\s+(\d{1,2})\b/);
  return bare ? { time: null, unclear: true } : { time: null, unclear: false };
}

const PRONOUN = /^(this|that|the|same|him|her|them|he|she|they)(\s+(member|person|student|one))?$/;

function cleanName(s: string): string {
  return s
    .replace(/\b(student id|student|member|id)\b/g, " ")
    .replace(/[?!.,"“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseIntent(raw: string, last: Intent | null): Intent {
  const original = raw.trim();
  const t = original.toLowerCase().replace(/\s+/g, " ");
  if (!t) return { type: "unknown" };

  if (/^(help|hi|hello|hey|what can you (do|answer)|how do i use)\b/.test(t)) return { type: "help" };
  if (/^(more|next|next page|show more|see more|continue)\??$/.test(t)) return { type: "more" };

  const id = t.match(ID_RE)?.[0];
  const dept = findDepartmentInText(t);
  const day = extractDay(t);
  const slot = extractSlot(t);
  const { time, unclear } = extractTime(t);

  const asksCommute = /commut|travel|transport|get to (campus|uni)|come to (campus|uni)/.test(t);
  const asksStay = /\b(stay|late|until|till|til)\b/.test(t) && (time !== null || unclear || /stay|late/.test(t));
  const asksNoClass = /(no|without|free of|not have|don'?t have|zero)\s+(any\s+)?class(es)?|free|available/.test(t) && (day !== null || slot !== null);
  const asksCount = /how many|count|number of|headcount/.test(t);

  if (asksCommute) {
    if (id) return { type: "commute", query: id };
    const m =
      t.match(/how does (.+?) (?:commute|travel|get)/) ??
      t.match(/does (.+?) commute/) ??
      t.match(/commute (?:of|for) (.+)/) ??
      t.match(/(.+?)'s commute/);
    const who = m ? cleanName(m[1]!) : "";
    if (!who || PRONOUN.test(who)) return { type: "commute", query: LAST_MEMBER };
    return { type: "commute", query: who };
  }

  if (asksNoClass || (/class/.test(t) && (day || slot) && /who|which|list|members/.test(t))) {
    return { type: "noClass", dept, day, slot, page: 1 };
  }
  if (asksStay) return { type: "stay", dept, time, timeUnclear: unclear, page: 1 };
  if (asksCount && /department|each|per|by dept/.test(t)) return { type: "countDepts" };

  if (id) return { type: "find", query: id };

  const findM =
    original.match(/^\s*is\s+(.+?)\s+(?:in|a member|part of|a part of|on)\b/i) ??
    original.match(/^\s*(?:find|look up|lookup|search for|search|show me|tell me about|who is)\s+(.+)$/i);
  if (findM) {
    const name = cleanName(findM[1]!);
    if (name && !findDepartmentInText(name.toLowerCase())) return { type: "find", query: name };
  }

  if (dept && /who|list|members|show|people|everyone|in\b/.test(t)) return { type: "listDept", dept, page: 1 };
  if (asksCount) return { type: "countDepts" };

  // Follow-ups: only a modifier (day / slot / department / time) and a previous question.
  if (last && (day || slot || dept || time)) {
    if (last.type === "noClass") return { ...last, dept: dept ?? last.dept, day: day ?? last.day, slot: slot ?? last.slot, page: 1 };
    if (last.type === "stay") return { ...last, dept: dept ?? last.dept, time: time ?? last.time, timeUnclear: unclear, page: 1 };
    if (last.type === "listDept" && dept) return { ...last, dept, page: 1 };
  }
  return { type: "unknown" };
}

import { normalizeText } from "../data/departments";
import { formatTime } from "../data/lateStay";
import { countByDepartment, findCanStay, findMembers, findNoClass, listByDepartment } from "../search";
import { GROUP_LABEL, type GroupKey, type Member } from "../types";
import { LAST_MEMBER, parseIntent, type Intent } from "./intent";
import type { SessionState } from "./sessions";

export interface ReplyRow { title: string; subtitle: string; detail?: string }
export interface ChatReply {
  kind: "answer" | "clarify" | "no_match" | "unknown" | "error";
  text: string;
  rows?: ReplyRow[];
  note?: string;
  suggestions?: string[];
}

const row = (m: Member, detail?: string): ReplyRow => ({ title: m.fullName, subtitle: `${m.studentId} · ${m.department}`, detail });
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const CAVEAT = "No class doesn't guarantee availability for society work.";

function lateStayText(m: Member): string {
  const { original, untilTime, conditions } = m.lateStay;
  if (!original && !untilTime) return "Late stay: not recorded.";
  const said = original ? `said “${original}”` : "";
  if (!untilTime) {
    return `Late stay: ${said}.${conditions ? ` Conditions noted: ${conditions}.` : ""} No firm time recorded, so treat as unknown.`;
  }
  return `Late stay: until ${formatTime(untilTime)}${conditions ? ` (${conditions})` : ""}${said ? `; ${said}` : ""}.`;
}
function scheduleLine(m: Member, g: GroupKey): string {
  const s = m.schedule[g];
  if (!s.answered) return `${GROUP_LABEL[g]}: not recorded`;
  return s.occupiedSlots.length ? `${GROUP_LABEL[g]}: classes in slot ${s.occupiedSlots.join(", ")}` : `${GROUP_LABEL[g]}: no classes`;
}
function memberDetail(m: Member): ReplyRow {
  const groups: GroupKey[] = ["monWed", "tueThu", "sat", "sun"];
  return row(m, [`Commute: ${m.commute ?? "not recorded"}.`, lateStayText(m), ...groups.map((g) => scheduleLine(m, g))].join("\n"));
}

function clarify(intent: Intent, cands: Member[], state: SessionState, query: string): ChatReply {
  state.pending = { intent, candidateIds: cands.slice(0, 10).map((m) => m.studentId) };
  return {
    kind: "clarify",
    text: `${plural(cands.length, "member")} match “${query}”. Which one do you mean? Reply with a student ID or full name.`,
    rows: cands.slice(0, 10).map((m) => row(m)),
    note: cands.length > 10 ? `Showing 10 of ${cands.length}. Add a surname or use a student ID.` : undefined,
  };
}

function tryResolve(message: string, members: Member[], ids: string[]): Member | null {
  const cands = ids.map((id) => members.find((m) => m.studentId === id)).filter((m): m is Member => !!m);
  const byId = cands.filter((m) => message.includes(m.studentId));
  if (byId.length === 1) return byId[0]!;
  const t = normalizeText(message);
  const n = t.match(/^(?:number\s+)?(\d{1,2})$/);
  if (n && cands[Number(n[1]) - 1]) return cands[Number(n[1]) - 1]!;
  const byName = cands.filter((m) => normalizeText(m.fullName) === t);
  return byName.length === 1 ? byName[0]! : null;
}

export function handleMessage(state: SessionState, message: string, members: Member[]): ChatReply {
  // 1) Answer to a "which person?" question.
  if (state.pending) {
    const chosen = tryResolve(message, members, state.pending.candidateIds);
    const { intent } = state.pending;
    state.pending = null;
    if (chosen && (intent.type === "find" || intent.type === "commute")) {
      return run({ ...intent, query: chosen.studentId }, state, members);
    }
  }
  const intent = parseIntent(message, state.lastIntent);
  return run(intent, state, members);
}

/** Run an already-validated intent (used by the optional AI adapter). */
export function handleIntent(state: SessionState, intent: Intent, members: Member[]): ChatReply {
  return run(intent, state, members);
}

function run(intent: Intent, state: SessionState, members: Member[]): ChatReply {
  switch (intent.type) {
    case "help":
      return {
        kind: "answer",
        text: "I can look up accepted DIGICON members by name or student ID, list departments, and check class schedules, commutes and late-stay answers.",
        suggestions: [
          "Is Ahmed in DIGICON?",
          "How many members are in each department?",
          "Which HR members have no classes on Monday, second slot?",
          "Who can stay until 5 pm?",
        ],
      };

    case "more": {
      const last = state.lastIntent;
      if (!last || !("page" in last)) return { kind: "unknown", text: "There's no list to continue. Ask a question first." };
      return run({ ...last, page: last.page + 1 } as Intent, state, members);
    }

    case "find": {
      const r = findMembers(members, intent.query);
      if (r.kind === "error") return { kind: "error", text: r.message };
      if (r.kind === "no_match") {
        return { kind: "no_match", text: `No accepted member matches “${intent.query}”. Check the spelling or search by student ID.` };
      }
      if (r.data.length > 1) return clarify(intent, r.data, state, intent.query);
      const m = r.data[0]!;
      state.lastIntent = intent;
      state.lastMemberId = m.studentId;
      return { kind: "answer", text: `Yes. ${m.fullName} (${m.studentId}) is an accepted member in ${m.department}.`, rows: [memberDetail(m)] };
    }

    case "commute": {
      let m: Member | undefined;
      if (intent.query === LAST_MEMBER) {
        m = members.find((x) => x.studentId === state.lastMemberId);
        if (!m) return { kind: "clarify", text: "Which member do you mean? Give a name or student ID." };
      } else {
        const r = findMembers(members, intent.query);
        if (r.kind === "error") return { kind: "error", text: r.message };
        if (r.kind === "no_match") return { kind: "no_match", text: `No accepted member matches “${intent.query}”.` };
        if (r.data.length > 1) return clarify(intent, r.data, state, intent.query);
        m = r.data[0]!;
      }
      state.lastIntent = intent;
      state.lastMemberId = m.studentId;
      return {
        kind: "answer",
        text: m.commute ? `${m.fullName} (${m.studentId}) commutes: ${m.commute}` : `No commute is recorded for ${m.fullName} (${m.studentId}).`,
      };
    }

    case "listDept": {
      const r = listByDepartment(members, intent.dept, intent.page);
      state.lastIntent = intent;
      if (r.kind !== "ok") return { kind: "no_match", text: `No accepted members are recorded in ${intent.dept}.` };
      const { items, total, page, pageSize } = r.data;
      const from = (page - 1) * pageSize + 1;
      if (!items.length) return { kind: "no_match", text: `No more members in ${intent.dept}.` };
      return {
        kind: "answer",
        text: `${intent.dept} has ${plural(total, "accepted member")}.`,
        rows: items.map((m) => row(m)),
        note: total > from + items.length - 1 ? `Showing ${from}-${from + items.length - 1} of ${total}. Say “more” for the next page.` : undefined,
      };
    }

    case "countDepts": {
      state.lastIntent = intent;
      const { counts, total } = countByDepartment(members);
      return {
        kind: "answer",
        text: `${plural(total, "accepted member")} in total.`,
        rows: Object.entries(counts).map(([d, n]) => ({ title: d, subtitle: String(n) })),
      };
    }

    case "noClass": {
      if (!intent.day || !intent.slot) {
        state.lastIntent = intent;
        return { kind: "clarify", text: `Which ${!intent.day ? "day" : "slot"}${!intent.day && !intent.slot ? " and slot" : ""}? For example: “Monday, second slot”.` };
      }
      const r = findNoClass(members, { day: intent.day, slot: intent.slot, department: intent.dept, page: intent.page });
      state.lastIntent = intent;
      if (r.kind === "error") return { kind: "error", text: r.message };
      if (r.kind === "no_match") return { kind: "no_match", text: "No members in that department." };
      const d = r.data;
      const scope = d.department ? `${d.department} members` : "members";
      const head = `${cap(d.day)}, slot ${d.slot}: ${plural(d.confirmed.total, "confirmed " + "no-class member")}${d.department ? ` in ${d.department}` : ""} of ${d.totalInScope} ${scope}.`;
      const { items, page, pageSize, total } = d.confirmed;
      const from = (page - 1) * pageSize + 1;
      const verb = (n: number) => (n === 1 ? "has" : "have");
      const parts = [`${d.hasClassCount} ${verb(d.hasClassCount)} class`, `${d.unknown.length} ${verb(d.unknown.length)} no schedule recorded for this day`];
      return {
        kind: "answer",
        text: `${head} ${parts.join("; ")}. ${CAVEAT}`,
        rows: [
          ...items.map((m) => row(m)),
          ...(page === 1 && d.unknown.length
            ? d.unknown.slice(0, 5).map((m) => row(m, "Schedule unknown for this day"))
            : []),
        ],
        note:
          total > from + items.length - 1
            ? `Showing ${from}-${from + items.length - 1} of ${total} confirmed. Say “more” for the next page.`
            : d.unknown.length > 5 && page === 1
              ? `Showing 5 of ${d.unknown.length} members with unknown schedules.`
              : undefined,
      };
    }

    case "stay": {
      if (intent.timeUnclear && !intent.time) {
        state.lastIntent = intent;
        return { kind: "clarify", text: "Please include am or pm, for example “5 pm”." };
      }
      if (!intent.time) {
        state.lastIntent = intent;
        return { kind: "clarify", text: "Until what time? For example: “Who can stay until 5 pm?”" };
      }
      const r = findCanStay(members, { time: intent.time, department: intent.dept, page: intent.page });
      state.lastIntent = intent;
      if (r.kind === "error") return { kind: "error", text: r.message };
      if (r.kind === "no_match") return { kind: "no_match", text: "No members in that department." };
      const d = r.data;
      const { items, total, page, pageSize } = d.yes;
      const from = (page - 1) * pageSize + 1;
      const extra = [
        d.conditional.length ? `${plural(d.conditional.length, "member")} could stay only under conditions` : null,
        d.unknown.length ? `${d.unknown.length} have no firm time recorded` : null,
      ].filter(Boolean);
      return {
        kind: "answer",
        text: `Until ${formatTime(d.time)}${d.department ? ` in ${d.department}` : ""}: ${plural(total, "member")} recorded as able to stay without conditions.${extra.length ? " " + extra.join("; ") + "." : ""}`,
        rows: [
          ...items.map((m) => row(m, m.lateStay.original ? `Said: “${m.lateStay.original}”` : undefined)),
          ...(page === 1 ? d.conditional.slice(0, 5).map((m) => row(m, `Conditional: ${m.lateStay.conditions}`)) : []),
        ],
        note: total > from + items.length - 1 ? `Showing ${from}-${from + items.length - 1} of ${total}. Say “more” for the next page.` : undefined,
      };
    }

    default:
      return {
        kind: "unknown",
        text: "I can't answer that from the member records. Try a name, student ID, department, class slot or late-stay time.",
        suggestions: ["How many members are in each department?", "Who can stay until 5 pm?"],
      };
  }
}

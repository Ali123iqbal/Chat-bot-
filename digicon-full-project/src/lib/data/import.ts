import { parseCsv } from "./csv";
import { resolveDepartment, normalizeText } from "./departments";
import { emptySchedule, parseScheduleCell } from "./schedule";
import { parseTime } from "./lateStay";
import type { GroupKey, Member } from "../types";

export interface ImportConfig {
  idPattern: RegExp;
  /** Required only if the file has an acceptance-like column. */
  acceptance?: { column: string; value: string };
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): ImportConfig {
  const column = env.DIGICON_ACCEPT_COLUMN?.trim();
  const value = env.DIGICON_ACCEPT_VALUE?.trim();
  return {
    idPattern: new RegExp(env.DIGICON_ID_PATTERN?.trim() || "^\\d{5}-\\d{5}$"),
    acceptance: column && value ? { column, value } : undefined,
  };
}

/** Agreed CSV template. Header matching ignores case, spaces and punctuation. */
const COLUMNS = {
  studentId: ["student_id", "studentid", "id"],
  fullName: ["full_name", "fullname", "name"],
  department: ["department", "dept"],
  commute: ["commute"],
  lateStayOriginal: ["late_stay_original", "late_stay", "latestay"],
  lateStayUntil: ["late_stay_until"],
  lateStayConditions: ["late_stay_conditions"],
  monWed: ["schedule_mon_wed", "mon_wed", "monday_wednesday"],
  tueThu: ["schedule_tue_thu", "tue_thu", "tuesday_thursday"],
  sat: ["schedule_sat", "saturday"],
  sun: ["schedule_sun", "sunday"],
  semester: ["timetable_semester", "semester"],
  updatedAt: ["updated_at", "update_date"],
} as const;
type ColKey = keyof typeof COLUMNS;
const REQUIRED: ColKey[] = ["studentId", "fullName", "department", "commute", "lateStayOriginal", "monWed", "tueThu", "sat", "sun"];
const ACCEPTANCE_LIKE = /accept|applicant|decision|status|shortlist/;
const MAX_FIELD = 300;

const key = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const clean = (s: string | undefined): string =>
  (s ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ").trim().slice(0, MAX_FIELD);
const orNull = (s: string): string | null => (s === "" ? null : s);

export interface ImportResult {
  ok: boolean;
  members: Member[];
  errors: string[];
  ignoredColumns: string[];
}

export function importMembers(csvText: string, cfg: ImportConfig): ImportResult {
  const errors: string[] = [];
  const rows = parseCsv(csvText);
  if (rows.length === 0) return { ok: false, members: [], errors: ["The file is empty."], ignoredColumns: [] };

  const header = rows[0]!.map(key);
  const idx: Partial<Record<ColKey, number>> = {};
  for (const k of Object.keys(COLUMNS) as ColKey[]) {
    const i = header.findIndex((h) => (COLUMNS[k] as readonly string[]).includes(h));
    if (i >= 0) idx[k] = i;
  }
  for (const k of REQUIRED) {
    if (idx[k] === undefined) errors.push(`Missing required column: ${COLUMNS[k][0]}`);
  }

  const used = new Set(Object.values(idx));
  let acceptIdx = -1;
  if (cfg.acceptance) {
    acceptIdx = header.indexOf(key(cfg.acceptance.column));
    if (acceptIdx < 0) errors.push(`Acceptance column "${cfg.acceptance.column}" was configured but is not in the file.`);
    else used.add(acceptIdx);
  } else {
    const suspicious = header.filter((h) => ACCEPTANCE_LIKE.test(h));
    if (suspicious.length) {
      errors.push(
        `Column(s) ${suspicious.join(", ")} look like an acceptance/applicant column. ` +
          `Refusing to import a possibly mixed dataset: set DIGICON_ACCEPT_COLUMN and DIGICON_ACCEPT_VALUE, or remove the column.`,
      );
    }
  }
  const ignoredColumns = rows[0]!.filter((_, i) => !used.has(i)).map((h) => h.trim()).filter(Boolean);
  if (errors.length) return { ok: false, members: [], errors, ignoredColumns };

  const get = (r: string[], k: ColKey) => clean(idx[k] === undefined ? "" : r[idx[k]!]);
  const seen = new Map<string, number>();
  const members: Member[] = [];

  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    if (cfg.acceptance && clean(r[acceptIdx]).toLowerCase() !== cfg.acceptance.value.toLowerCase()) return;
    const rowErrors: string[] = [];

    const studentId = get(r, "studentId");
    if (!studentId) rowErrors.push("missing student ID");
    else if (!cfg.idPattern.test(studentId)) rowErrors.push(`student ID "${studentId}" does not match the agreed format`);
    else if (seen.has(studentId)) rowErrors.push(`duplicate student ID ${studentId} (first seen on line ${seen.get(studentId)})`);
    else seen.set(studentId, line);

    const fullName = get(r, "fullName");
    if (!fullName) rowErrors.push("missing full name");

    const department = resolveDepartment(get(r, "department"));
    if (!department) rowErrors.push(`unknown department "${get(r, "department")}"`);

    const schedule = emptySchedule();
    for (const g of ["monWed", "tueThu", "sat", "sun"] as GroupKey[]) {
      const p = parseScheduleCell(get(r, g), g);
      if (p.ok) schedule[g] = p.value;
      else rowErrors.push(`${COLUMNS[g][0]}: ${p.error}`);
    }

    // Interpreted late-stay time: only kept when unambiguous; otherwise the row is flagged.
    const untilRaw = get(r, "lateStayUntil");
    let untilTime: string | null = null;
    if (untilRaw) {
      untilTime = parseTime(untilRaw);
      if (!untilTime) rowErrors.push(`late_stay_until "${untilRaw}" is ambiguous; use e.g. 17:00 or 5 pm, or leave blank`);
    }

    if (rowErrors.length) {
      errors.push(...rowErrors.map((e) => `Line ${line}: ${e}`));
      return;
    }
    members.push({
      studentId,
      fullName,
      department: department!,
      commute: orNull(get(r, "commute")),
      lateStay: {
        original: orNull(get(r, "lateStayOriginal")),
        untilTime,
        conditions: orNull(get(r, "lateStayConditions")),
      },
      schedule,
      timetableSemester: orNull(get(r, "semester")),
      updatedAt: orNull(get(r, "updatedAt")),
      status: "accepted",
    });
  });

  if (!errors.length && members.length === 0) errors.push("The file contains no member rows.");
  return { ok: errors.length === 0, members: errors.length ? [] : members, errors, ignoredColumns };
}

export { normalizeText };

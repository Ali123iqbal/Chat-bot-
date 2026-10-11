export const DEPARTMENTS = [
  "Game Tech",
  "Tech Development",
  "HR",
  "Marketing",
  "Media & Production",
  "Logistics",
  "Creatives & Design",
  "Events & Operations",
] as const;
export type Department = (typeof DEPARTMENTS)[number];

export type GroupKey = "monWed" | "tueThu" | "sat" | "sun";
export const GROUP_SLOTS: Record<GroupKey, number> = { monWed: 4, tueThu: 4, sat: 3, sun: 3 };
export const GROUP_LABEL: Record<GroupKey, string> = {
  monWed: "Monday/Wednesday",
  tueThu: "Tuesday/Thursday",
  sat: "Saturday",
  sun: "Sunday",
};

export type Day =
  | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export interface GroupSchedule {
  /** false = blank/unanswered. Never inferred from empty cells. */
  answered: boolean;
  occupiedSlots: number[];
}
export type Schedule = Record<GroupKey, GroupSchedule>;

export interface LateStay {
  /** Original wording, kept exactly (trimmed). */
  original: string | null;
  /** Interpreted "HH:MM", only when unambiguous. */
  untilTime: string | null;
  /** e.g. "with advance notice". Any value here means the answer is conditional. */
  conditions: string | null;
}

export interface Member {
  studentId: string;
  fullName: string;
  department: Department;
  commute: string | null;
  lateStay: LateStay;
  schedule: Schedule;
  timetableSemester: string | null;
  updatedAt: string | null;
  /** Internal label; the source contains accepted members only. */
  status: "accepted";
}

/** Three distinct outcomes; "missing information" lives inside `data`. */
export type Outcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "no_match" }
  | { kind: "error"; message: string };

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DatasetStatus {
  version: number;
  loadedAt: string | null;
  memberCount: number;
  lastSuccessfulRefresh: string | null;
  lastRefreshError: { at: string; errors: string[] } | null;
}

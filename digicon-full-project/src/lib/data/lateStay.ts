/** Parse an unambiguous time like "17:00", "5 pm", "5:30pm" into "HH:MM". */
export function parseTime(raw: string): string | null {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const mer = m[3];
  if (min > 59) return null;
  if (mer) {
    if (h < 1 || h > 12) return null;
    if (mer === "pm" && h !== 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
  } else if (h > 23) return null;
  else if (h >= 1 && h <= 7) {
    // "5" with no am/pm is ambiguous for a late-stay answer: refuse to guess.
    return null;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function formatTime(hhmm: string): string {
  const [hs, ms] = hhmm.split(":");
  const h = Number(hs);
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return ms === "00" ? `${h12} ${suffix}` : `${h12}:${ms} ${suffix}`;
}

export type StayVerdict = "yes" | "conditional" | "no" | "unknown";

export function canStayUntil(
  ls: { untilTime: string | null; conditions: string | null },
  wanted: string,
): StayVerdict {
  if (!ls.untilTime) return "unknown";
  if (ls.conditions) return ls.untilTime >= wanted ? "conditional" : "no";
  return ls.untilTime >= wanted ? "yes" : "no";
}

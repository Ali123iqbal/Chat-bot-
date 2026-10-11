import { DEPARTMENTS, type Department } from "../types";

export function normalizeText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Aliases -> official name. Official names are always accepted too. */
const ALIASES: Record<string, Department> = {
  "game tech": "Game Tech",
  "game technology": "Game Tech",
  "games": "Game Tech",
  "game": "Game Tech",
  "tech development": "Tech Development",
  "tech dev": "Tech Development",
  "development": "Tech Development",
  "dev": "Tech Development",
  "hr": "HR",
  "human resources": "HR",
  "marketing": "Marketing",
  "media": "Media & Production",
  "production": "Media & Production",
  "media and production": "Media & Production",
  "logistics": "Logistics",
  "creatives and design": "Creatives & Design",
  "creatives": "Creatives & Design",
  "design": "Creatives & Design",
  "creative": "Creatives & Design",
  "events and operations": "Events & Operations",
  "events": "Events & Operations",
  "operations": "Events & Operations",
  "ops": "Events & Operations",
};
for (const d of DEPARTMENTS) ALIASES[normalizeText(d)] = d;

export function resolveDepartment(raw: string | null | undefined): Department | null {
  if (!raw) return null;
  return ALIASES[normalizeText(raw)] ?? null;
}

/** Find a department mentioned anywhere in free text (longest alias wins). */
export function findDepartmentInText(text: string): Department | null {
  const norm = ` ${normalizeText(text)} `;
  const keys = Object.keys(ALIASES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (norm.includes(` ${k} `)) return ALIASES[k]!;
  }
  return null;
}

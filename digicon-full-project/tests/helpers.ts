import fs from "node:fs";
import path from "node:path";
import { importMembers, configFromEnv } from "@/lib/data/import";
import type { Member } from "@/lib/types";

export const cfg = configFromEnv({});
export const fixtureCsv = () => fs.readFileSync(path.join(__dirname, "..", "fixtures", "members.csv"), "utf8");
export function fixtureMembers(): Member[] {
  const r = importMembers(fixtureCsv(), cfg);
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.members;
}

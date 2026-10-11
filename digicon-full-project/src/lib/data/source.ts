import fs from "node:fs";
import path from "node:path";
import { configFromEnv, importMembers, type ImportConfig } from "./import";
import type { DatasetStatus, Member } from "../types";

/** Any connector (CSV now, Google Sheets / database later) implements this. Read-only. */
export interface MemberSource {
  getMembers(): Promise<Member[]>;
  getStatus(): Promise<DatasetStatus>;
}

interface StatusFile {
  lastSuccessfulRefresh: string | null;
  lastRefreshError: { at: string; errors: string[] } | null;
}

const dataDir = () => process.env.DIGICON_DATA_DIR || path.join(process.cwd(), "data");

/**
 * Reads the validated active dataset written by the refresh tool.
 * The chatbot API never writes here; a changed file (mtime) invalidates the cache.
 */
export class CsvMemberSource implements MemberSource {
  private cache: { mtimeMs: number; members: Member[]; loadedAt: string; version: number } | null = null;
  private version = 0;

  constructor(
    private readonly dir: string = dataDir(),
    private readonly cfg: ImportConfig = configFromEnv(),
  ) {}

  private load() {
    const file = path.join(this.dir, "active.csv");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new Error("No dataset has been loaded yet.");
    }
    if (!this.cache || this.cache.mtimeMs !== stat.mtimeMs) {
      const res = importMembers(fs.readFileSync(file, "utf8"), this.cfg);
      if (!res.ok) throw new Error("The active dataset failed validation.");
      this.version += 1;
      this.cache = { mtimeMs: stat.mtimeMs, members: res.members, loadedAt: new Date().toISOString(), version: this.version };
    }
    return this.cache;
  }

  async getMembers(): Promise<Member[]> {
    return this.load().members;
  }

  async getStatus(): Promise<DatasetStatus> {
    let sf: StatusFile = { lastSuccessfulRefresh: null, lastRefreshError: null };
    try {
      sf = JSON.parse(fs.readFileSync(path.join(this.dir, "status.json"), "utf8"));
    } catch { /* no status yet */ }
    const c = this.load();
    return { version: c.version, loadedAt: c.loadedAt, memberCount: c.members.length, ...sf };
  }
}

export interface RefreshOutcome {
  ok: boolean;
  errors: string[];
  memberCount: number;
  ignoredColumns: string[];
}

/**
 * Maintainer-only. Validates the WHOLE file first; only then atomically replaces active.csv.
 * On failure the last valid dataset is kept and the errors are recorded in status.json.
 */
export function refreshDataset(csvPath: string, dir: string = dataDir(), cfg: ImportConfig = configFromEnv()): RefreshOutcome {
  fs.mkdirSync(dir, { recursive: true });
  const statusPath = path.join(dir, "status.json");
  let prev: StatusFile = { lastSuccessfulRefresh: null, lastRefreshError: null };
  try { prev = JSON.parse(fs.readFileSync(statusPath, "utf8")); } catch { /* first run */ }

  let text: string;
  try {
    text = fs.readFileSync(csvPath, "utf8");
  } catch {
    const errors = [`Could not read ${csvPath}.`];
    fs.writeFileSync(statusPath, JSON.stringify({ ...prev, lastRefreshError: { at: new Date().toISOString(), errors } }, null, 2));
    return { ok: false, errors, memberCount: 0, ignoredColumns: [] };
  }
  const res = importMembers(text, cfg);
  const now = new Date().toISOString();
  if (!res.ok) {
    fs.writeFileSync(statusPath, JSON.stringify({ ...prev, lastRefreshError: { at: now, errors: res.errors.slice(0, 200) } }, null, 2));
    return { ok: false, errors: res.errors, memberCount: 0, ignoredColumns: res.ignoredColumns };
  }
  const tmp = path.join(dir, `active.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path.join(dir, "active.csv"));
  fs.writeFileSync(statusPath, JSON.stringify({ lastSuccessfulRefresh: now, lastRefreshError: null }, null, 2));
  return { ok: true, errors: [], memberCount: res.members.length, ignoredColumns: res.ignoredColumns };
}

let shared: MemberSource | null = null;
export function getSource(): MemberSource {
  const g = globalThis as unknown as { __digiconSource?: MemberSource };
  return (g.__digiconSource ??= shared ??= new CsvMemberSource());
}
export function setSourceForTests(s: MemberSource | null) {
  shared = s;
  (globalThis as unknown as { __digiconSource?: MemberSource | undefined }).__digiconSource = s ?? undefined;
}

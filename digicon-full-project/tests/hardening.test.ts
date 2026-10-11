import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CappedInterpreter, NoopInterpreter, setInterpreter, validateIntent, type IntentInterpreter } from "@/lib/ai/adapter";
import { SessionStore } from "@/lib/chat/sessions";
import { CsvMemberSource, refreshDataset, setSourceForTests } from "@/lib/data/source";
import { importMembers } from "@/lib/data/import";
import { EnvTokenAuth, setAuthForTests } from "@/lib/server/auth";
import { deleteChat, deleteSession, getStatus, postChat } from "@/lib/server/handlers";
import { RateLimiter } from "@/lib/server/limits";
import { handleMessage } from "@/lib/chat/engine";
import { cfg, fixtureCsv, fixtureMembers } from "./helpers";

const TOKEN_A = "a".repeat(24);
const TOKEN_B = "b".repeat(24);
let dir: string;

const req = (method: string, url: string, token?: string, body?: unknown, ip?: string) =>
  new Request("http://x" + url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(ip ? { "x-forwarded-for": ip } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const chat = async (token: string | undefined, message: string, conversationId?: string, ip?: string) => {
  const res = await postChat(req("POST", "/api/chat", token, { message, conversationId }, ip));
  return { res, body: (await res.json().catch(() => ({}))) as any };
};

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "digicon-"));
  const csv = path.join(dir, "in.csv");
  fs.writeFileSync(csv, fixtureCsv());
  refreshDataset(csv, dir, cfg);
  setSourceForTests(new CsvMemberSource(dir, cfg));
  setAuthForTests(new EnvTokenAuth(`${TOKEN_A}:alice,${TOKEN_B}:bob`));
  const g = globalThis as any;
  g.__digiconSessions = new SessionStore();
  g.__digiconLimiter = new RateLimiter();
  g.__digiconAuthFail = new RateLimiter(10, 60_000);
  setInterpreter(null);
});
afterEach(() => { vi.restoreAllMocks(); setSourceForTests(null); setAuthForTests(null); setInterpreter(null); });

describe("logout ends every conversation of that user only", () => {
  it("DELETE /api/session", async () => {
    const a1 = (await chat(TOKEN_A, "Find Zainab Ali")).body.conversationId;
    const a2 = (await chat(TOKEN_A, "Find Sara Malik")).body.conversationId;
    const b1 = (await chat(TOKEN_B, "Find Omar Sheikh")).body.conversationId;
    expect((await deleteSession(req("DELETE", "/api/session", TOKEN_A))).status).toBe(204);
    expect((await chat(TOKEN_A, "hi", a1)).res.status).toBe(404);
    expect((await chat(TOKEN_A, "hi", a2)).res.status).toBe(404);
    expect((await chat(TOKEN_B, "hi", b1)).res.status).toBe(200);
    expect((await deleteSession(req("DELETE", "/api/session"))).status).toBe(401);
  });
});

describe("failed sign-in throttling", () => {
  it("blocks a client address after repeated failures, even with a correct token afterwards", async () => {
    for (let i = 0; i < 10; i++) expect((await chat("wrong-token-wrong-token-" + i, "hi", undefined, "9.9.9.9")).res.status).toBe(401);
    const blocked = await chat(TOKEN_A, "hi", undefined, "9.9.9.9");
    expect(blocked.res.status).toBe(429);
    expect(blocked.body.error).toBe("too_many_failed_attempts");
    expect((await getStatus(req("GET", "/api/status", TOKEN_A, undefined, "9.9.9.9"))).status).toBe(429);
    expect((await deleteChat(req("DELETE", "/api/chat?conversationId=x", TOKEN_A, undefined, "9.9.9.9"))).status).toBe(429);
  });
  it("does not affect other addresses, and successful requests are not counted", async () => {
    for (let i = 0; i < 10; i++) await chat("wrong-token-wrong-token-" + i, "hi", undefined, "9.9.9.9");
    expect((await chat(TOKEN_A, "hi", undefined, "8.8.8.8")).res.status).toBe(200);
    for (let i = 0; i < 12; i++) expect((await chat(TOKEN_B, "hi", undefined, "7.7.7.7")).res.status).toBe(200);
  });
});

describe("late-stay conditions are kept even without a time", () => {
  const head = "student_id,full_name,department,commute,late_stay_original,late_stay_until,late_stay_conditions,schedule_mon_wed,schedule_tue_thu,schedule_sat,schedule_sun\n";
  it("stores them, still treats the answer as unknown, and shows them", () => {
    const r = importMembers(head + "20231-00001,Test Person,HR,Bus,Maybe after exams,,after exams,,,,\n", cfg);
    expect(r.ok).toBe(true);
    const m = r.members[0]!;
    expect(m.lateStay).toEqual({ original: "Maybe after exams", untilTime: null, conditions: "after exams" });
    const s = { lastIntent: null, lastMemberId: null, pending: null };
    const reply = handleMessage(s, "Find student ID 20231-00001", r.members);
    expect(reply.rows![0]!.detail).toContain("Conditions noted: after exams");
    expect(reply.rows![0]!.detail).toContain("treat as unknown");
    const stay = handleMessage({ ...s }, "Who can stay until 5 pm?", r.members);
    expect(stay.text).toContain("1 have no firm time recorded");
    expect(stay.rows ?? []).toHaveLength(0);
  });
});

describe("optional AI adapter", () => {
  it("is off by default: unknown questions stay unknown", async () => {
    const r = await chat(TOKEN_A, "Tell me a joke about spreadsheets");
    expect(r.body.reply.kind).toBe("unknown");
    expect(await new NoopInterpreter().interpret()).toBeNull();
  });

  it("validates model output against the allow-list", () => {
    expect(validateIntent({ type: "countDepts" })).toEqual({ type: "countDepts" });
    expect(validateIntent({ type: "noClass", dept: "HR", day: "monday", slot: 2, extra: "dropped" }))
      .toEqual({ type: "noClass", dept: "HR", day: "monday", slot: 2, page: 1 });
    for (const bad of [
      null, "x", {}, { type: "sql", query: "DROP TABLE members" },
      { type: "listDept", dept: "Cooking" }, { type: "listDept", dept: "HR'; DROP TABLE x;--" },
      { type: "noClass", dept: "HR", day: "monday", slot: 9 }, { type: "noClass", day: "someday", slot: 1 },
      { type: "stay", time: "5pm" }, { type: "stay", time: "25:00" },
      { type: "find", query: "x".repeat(101) }, { type: "find", query: "" },
    ]) expect(validateIntent(bad)).toBeNull();
  });

  it("uses a valid interpretation as a fallback, sending only the question text", async () => {
    const interpret = vi.fn(async (..._args: unknown[]) => ({ type: "stay", time: "17:00", dept: "HR" }));
    setInterpreter({ interpret } as IntentInterpreter);
    const r = await chat(TOKEN_A, "any HR folks around till dinner?");
    expect(r.body.reply.kind).toBe("answer");
    expect(r.body.reply.text).toContain("Until 5 pm in HR");
    expect(interpret).toHaveBeenCalledTimes(1);
    expect(interpret.mock.calls[0]).toEqual(["any HR folks around till dinner?"]); // no member data
  });

  it("ignores invalid or failing interpretations", async () => {
    setInterpreter({ interpret: async () => ({ type: "sql", query: "SELECT *" }) });
    expect((await chat(TOKEN_A, "weird question one")).body.reply.kind).toBe("unknown");
    setInterpreter({ interpret: async () => { throw new Error("provider down"); } });
    expect((await chat(TOKEN_A, "weird question two")).body.reply.kind).toBe("unknown");
  });

  it("does not call the interpreter when the rules already answer", async () => {
    const interpret = vi.fn(async () => null);
    setInterpreter({ interpret });
    await chat(TOKEN_A, "How many members are in each department?");
    expect(interpret).not.toHaveBeenCalled();
  });

  it("enforces a monthly cap and resets next month", async () => {
    let now = new Date("2026-10-15T00:00:00Z");
    const inner = vi.fn(async () => ({ type: "countDepts" }));
    const capped = new CappedInterpreter({ interpret: inner }, 2, () => now);
    await capped.interpret("a"); await capped.interpret("b");
    expect(await capped.interpret("c")).toBeNull();
    expect(inner).toHaveBeenCalledTimes(2);
    now = new Date("2026-11-01T00:00:00Z");
    expect(await capped.interpret("d")).not.toBeNull();
  });
});

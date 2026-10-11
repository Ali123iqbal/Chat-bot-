import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvTokenAuth, setAuthForTests } from "@/lib/server/auth";
import { CsvMemberSource, refreshDataset, setSourceForTests } from "@/lib/data/source";
import { SessionStore } from "@/lib/chat/sessions";
import { RateLimiter } from "@/lib/server/limits";
import { deleteChat, getStatus, postChat } from "@/lib/server/handlers";
import { cfg, fixtureCsv } from "./helpers";

const TOKEN_A = "a".repeat(24);
const TOKEN_B = "b".repeat(24);
let dir: string;

const req = (method: string, url: string, token?: string, body?: unknown) =>
  new Request("http://x" + url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const chat = async (token: string | undefined, message: string, conversationId?: string) => {
  const res = await postChat(req("POST", "/api/chat", token, { message, conversationId }));
  return { res, body: (await res.json()) as any };
};

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "digicon-"));
  const csv = path.join(dir, "in.csv");
  fs.writeFileSync(csv, fixtureCsv());
  expect(refreshDataset(csv, dir, cfg).ok).toBe(true);
  setSourceForTests(new CsvMemberSource(dir, cfg));
  setAuthForTests(new EnvTokenAuth(`${TOKEN_A}:alice,${TOKEN_B}:bob`));
  const g = globalThis as any;
  g.__digiconSessions = new SessionStore();
  g.__digiconLimiter = new RateLimiter();
  g.__digiconAuthFail = new RateLimiter(10, 60_000);
});
afterEach(() => { vi.restoreAllMocks(); setSourceForTests(null); setAuthForTests(null); });

describe("authorization", () => {
  it("rejects missing, wrong and short tokens on every route", async () => {
    for (const t of [undefined, "wrong-token-wrong-token-1", "short"]) {
      expect((await chat(t, "hi")).res.status).toBe(401);
      expect((await getStatus(req("GET", "/api/status", t))).status).toBe(401);
      expect((await deleteChat(req("DELETE", "/api/chat?conversationId=x", t))).status).toBe(401);
    }
  });
  it("fails closed when no tokens are configured", async () => {
    setAuthForTests(new EnvTokenAuth(""));
    expect((await chat(TOKEN_A, "hi")).res.status).toBe(401);
  });
});

describe("conversation isolation and lifecycle", () => {
  it("another user cannot use or probe someone else's conversation", async () => {
    const a = await chat(TOKEN_A, "Find Zainab Ali");
    const id = a.body.conversationId as string;
    const stolen = await chat(TOKEN_B, "How does this member commute?", id);
    expect(stolen.res.status).toBe(404);
    const same = await chat(TOKEN_A, "How does this member commute?", id);
    expect(same.body.reply.text).toContain("Motorbike");
    const unknown = await chat(TOKEN_B, "hi", "does-not-exist");
    expect(unknown.res.status).toBe(404); // indistinguishable
  });
  it("clear conversation ends the context; other users can't end it", async () => {
    const id = (await chat(TOKEN_A, "Find Zainab Ali")).body.conversationId;
    await deleteChat(req("DELETE", `/api/chat?conversationId=${id}`, TOKEN_B));
    expect((await chat(TOKEN_A, "hello", id)).res.status).toBe(200);
    await deleteChat(req("DELETE", `/api/chat?conversationId=${id}`, TOKEN_A));
    expect((await chat(TOKEN_A, "hello", id)).res.status).toBe(404);
  });
  it("expires after the idle timeout", () => {
    let t = 0;
    const store = new SessionStore(60_000, () => t);
    const id = store.start("alice");
    t = 59_000; expect(store.get(id, "alice")).not.toBeNull();
    t = 59_000 + 61_000; expect(store.get(id, "alice")).toBeNull();
  });
});

describe("limits", () => {
  it("validates message and body size, and rate-limits", async () => {
    expect((await chat(TOKEN_A, "x".repeat(501))).res.status).toBe(400);
    expect((await chat(TOKEN_A, "")).res.status).toBe(400);
    const big = await postChat(req("POST", "/api/chat", TOKEN_A, { message: "a", pad: "z".repeat(3000) }));
    expect(big.status).toBe(413);
    (globalThis as any).__digiconLimiter = new RateLimiter(2, 60_000);
    await chat(TOKEN_A, "hi"); await chat(TOKEN_A, "hi");
    expect((await chat(TOKEN_A, "hi")).res.status).toBe(429);
  });
  it("logs metadata only, never the question", async () => {
    const spy = console.info as unknown as ReturnType<typeof vi.fn>;
    await chat(TOKEN_A, "Find Zainab Ali");
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("POST /api/chat");
    expect(logged).not.toMatch(/Zainab/);
  });
});

describe("refresh, removal and errors", () => {
  it("a failed refresh keeps the last valid dataset and reports errors", async () => {
    const bad = path.join(dir, "bad.csv");
    fs.writeFileSync(bad, "student_id,full_name\n1,x\n");
    const out = refreshDataset(bad, dir, cfg);
    expect(out.ok).toBe(false);
    const still = await chat(TOKEN_A, "Find Zainab Ali");
    expect(still.body.reply.text).toContain("Zainab Ali");
    const st = await (await getStatus(req("GET", "/api/status", TOKEN_A))).json() as any;
    expect(st.lastRefreshError.summary.length).toBeGreaterThan(0);
    expect(st.lastSuccessfulRefresh).toBeTruthy();
    expect(st.memberCount).toBe(15);
  });

  it("a successful refresh removes members from future answers, and follow-ups re-query", async () => {
    const first = await chat(TOKEN_A, "Which HR members have no classes on Monday, second slot?");
    const id = first.body.conversationId;
    expect(JSON.stringify(first.body.reply)).toContain("Sara Malik");
    const lines = fixtureCsv().split("\n").filter((l) => !l.startsWith("20231-10003"));
    const next = path.join(dir, "next.csv");
    fs.writeFileSync(next, lines.join("\n"));
    await new Promise((r) => setTimeout(r, 20)); // ensure a new mtime
    expect(refreshDataset(next, dir, cfg).ok).toBe(true);
    const follow = await chat(TOKEN_A, "What about Tuesday?", id);
    expect(JSON.stringify(follow.body.reply)).not.toContain("Sara Malik");
    expect((await chat(TOKEN_A, "Find Sara Malik")).body.reply.kind).toBe("no_match");
  });

  it("a data outage is a 503 service error, not 'no match'", async () => {
    fs.rmSync(path.join(dir, "active.csv"));
    const r = await chat(TOKEN_A, "Find Zainab Ali");
    expect(r.res.status).toBe(503);
    expect(r.body.error).toBe("data_unavailable");
  });
});

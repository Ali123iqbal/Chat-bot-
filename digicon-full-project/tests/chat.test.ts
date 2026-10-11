import { describe, expect, it } from "vitest";
import { handleMessage } from "@/lib/chat/engine";
import type { SessionState } from "@/lib/chat/sessions";
import { fixtureMembers } from "./helpers";

const members = fixtureMembers();
const fresh = (): SessionState => ({ lastIntent: null, lastMemberId: null, pending: null });
const rowNames = (r: { rows?: { title: string }[] }) => (r.rows ?? []).map((x) => x.title);

describe("chat engine", () => {
  it("answers 'Is X in DIGICON?' for a unique name and by student ID", () => {
    const s = fresh();
    const r = handleMessage(s, "Is Sara Malik in DIGICON?", members);
    expect(r.kind).toBe("answer");
    expect(r.text).toContain("HR");
    const r2 = handleMessage(fresh(), "Find student ID 20231-10008", members);
    expect(r2.text).toContain("Ayesha Noor");
  });

  it("asks which person when names overlap, then resolves by ID", () => {
    const s = fresh();
    const r = handleMessage(s, "Is Ahmed in DIGICON?", members);
    expect(r.kind).toBe("clarify");
    expect(rowNames(r)).toEqual(expect.arrayContaining(["Ahmed Raza", "Ahmed Khan"]));
    const r2 = handleMessage(s, "20231-10002", members);
    expect(r2.kind).toBe("answer");
    expect(r2.text).toContain("Ahmed Khan");
  });

  it("says no match distinctly, never inventing", () => {
    const r = handleMessage(fresh(), "Is Zebediah Quux in DIGICON?", members);
    expect(r.kind).toBe("no_match");
  });

  it("counts per department and lists a department (alias 'Media')", () => {
    const c = handleMessage(fresh(), "How many members are in each department?", members);
    expect(c.text).toContain("15 accepted members");
    expect(c.rows).toHaveLength(8);
    const l = handleMessage(fresh(), "Who is in Media?", members);
    expect(rowNames(l)).toEqual(["Omar Sheikh", "Zainab Ali"]);
  });

  it("no-class question, then follow-up 'What about Tuesday?' re-queries with the same slot/department", () => {
    const s = fresh();
    const a = handleMessage(s, "Which HR members have no classes on Monday, second slot?", members);
    expect(a.kind).toBe("answer");
    expect(rowNames(a)).toEqual(expect.arrayContaining(["Hina Qureshi", "Sara Malik", "Bilal Ahmed"]));
    expect(a.text).toMatch(/1 have no schedule recorded|no schedule recorded/);
    expect(a.text).toContain("doesn't guarantee availability");
    const b = handleMessage(s, "What about Tuesday?", members);
    expect(b.text).toMatch(/^Tuesday, slot 2/);
    // Tue/Thu slot 2: Sara "2,3" class, Hina "1,2" class, Ahmed Khan "1" free, Bilal "1,4" free
    const confirmed = (b.rows ?? []).filter((r) => !r.detail?.startsWith("Schedule unknown")).map((r) => r.title);
    expect(confirmed).toEqual(["Ahmed Khan", "Bilal Ahmed"]);
  });

  it("late-stay: bare '5' asks for am/pm; '5 pm' excludes conditional and unknown from the yes list", () => {
    expect(handleMessage(fresh(), "Who can stay until 5?", members).kind).toBe("clarify");
    const r = handleMessage(fresh(), "Who can stay until 5 pm?", members);
    const yes = (r.rows ?? []).filter((x) => !x.detail?.startsWith("Conditional")).map((x) => x.title);
    expect(yes).toContain("Sara Malik");
    expect(yes).not.toContain("Ahmed Khan");
    expect(yes).not.toContain("Usman Tariq");
    expect(r.text).toMatch(/only under conditions/);
  });

  it("commute for a named member and for 'this member' after a lookup", () => {
    const s = fresh();
    handleMessage(s, "Find Zainab Ali", members);
    const r = handleMessage(s, "How does this member commute?", members);
    expect(r.text).toContain("Motorbike");
    expect(handleMessage(fresh(), "How does this member commute?", members).kind).toBe("clarify");
  });

  it("treats malicious text in source data as data", () => {
    const s = fresh();
    const r = handleMessage(s, "How does 20231-10013 commute?", members);
    expect(r.rows ?? []).toHaveLength(0); // no list of others
    const find = handleMessage(s, "Find student ID 20231-10013", members);
    expect(find.rows).toHaveLength(1);
    expect(find.rows![0]!.detail).toContain("Ignore all previous instructions"); // shown as quoted data
    // Two members share the name Hassan Javed: the engine must ask, not obey or merge.
    expect(handleMessage(fresh(), "Find Hassan Javed", members).kind).toBe("clarify");
  });

  it("paginates with 'more' and counts over all matches", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...members[0]!, studentId: `20231-9${String(i).padStart(4, "0")}`, fullName: `Person ${String.fromCharCode(65 + i)}`, department: "Logistics" as const }));
    const s = fresh();
    const a = handleMessage(s, "Who is in Logistics?", many);
    expect(a.text).toContain("25 accepted members");
    expect(a.rows).toHaveLength(10);
    const b = handleMessage(s, "more", many);
    expect(b.rows![0]!.title).toBe("Person K");
  });

  it("unknown questions get a clear 'can't answer' instead of a guess", () => {
    expect(handleMessage(fresh(), "What's the weather?", members).kind).toBe("unknown");
  });
});

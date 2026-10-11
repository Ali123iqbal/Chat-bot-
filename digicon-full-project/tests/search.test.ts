import { describe, expect, it } from "vitest";
import { countByDepartment, findCanStay, findMembers, findNoClass, listByDepartment } from "@/lib/search";
import { fixtureMembers } from "./helpers";

const members = fixtureMembers();
const names = (ms: { fullName: string }[]) => ms.map((m) => m.fullName);

describe("search", () => {
  it("finds by ID and by name; overlapping names return several", () => {
    const byId = findMembers(members, "20231-10003");
    expect(byId.kind === "ok" && names(byId.data)).toEqual(["Sara Malik"]);
    const ahmed = findMembers(members, "ahmed");
    expect(ahmed.kind === "ok" && ahmed.data.length).toBe(3); // Ahmed Raza, Ahmed Khan, Bilal Ahmed
    expect(findMembers(members, "Nobody Here").kind).toBe("no_match");
  });

  it("counts over all members and lists per department", () => {
    const { counts, total } = countByDepartment(members);
    expect(total).toBe(15);
    expect(counts["HR"]).toBe(4);
    expect(counts["Game Tech"]).toBe(1);
    const hr = listByDepartment(members, "HR");
    expect(hr.kind === "ok" && hr.data.total).toBe(4);
  });

  it("no-class search: grouped days, unknown reported separately, class counted", () => {
    const r = findNoClass(members, { day: "monday", slot: 2, department: "HR" });
    if (r.kind !== "ok") throw new Error("expected ok");
    // HR mon/wed: Ahmed Khan "2,4" -> class; Sara "1,3" -> free; Hina "No classes" -> free; Bilal blank -> unknown
    expect(names(r.data.confirmed.items)).toEqual(["Hina Qureshi", "Sara Malik"]);
    expect(r.data.hasClassCount).toBe(1);
    expect(names(r.data.unknown)).toEqual(["Bilal Ahmed"]);
  });

  it("Wednesday uses the same group as Monday; Friday has no timetable", () => {
    const mon = findNoClass(members, { day: "monday", slot: 1 });
    const wed = findNoClass(members, { day: "wednesday", slot: 1 });
    expect(mon).toEqual({ ...wed, data: { ...(wed as any).data, day: "monday" } });
    expect(findNoClass(members, { day: "friday", slot: 1 }).kind).toBe("error");
    expect(findNoClass(members, { day: "saturday", slot: 4 }).kind).toBe("error");
  });

  it("late-stay: unconditional vs conditional vs unknown", () => {
    const r = findCanStay(members, { time: "17:00" });
    if (r.kind !== "ok") throw new Error("expected ok");
    const yes = names(r.data.yes.items);
    expect(yes).toContain("Sara Malik");
    expect(yes).not.toContain("Ahmed Khan"); // "with advance notice"
    expect(names(r.data.conditional)).toContain("Ahmed Khan");
    expect(names(r.data.unknown)).toContain("Usman Tariq"); // blank answer stays unknown
    expect(names(r.data.unknown)).toContain("Omar Sheikh"); // "Yes" with no interpreted time stays unknown
  });

  it("caps page size", () => {
    const r = listByDepartment(members, "HR", 1);
    expect(r.kind === "ok" && r.data.pageSize).toBeLessThanOrEqual(10);
  });
});

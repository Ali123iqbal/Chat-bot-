import { describe, expect, it } from "vitest";
import { importMembers } from "@/lib/data/import";
import { cfg, fixtureCsv } from "./helpers";

const HEAD = "student_id,full_name,department,commute,late_stay_original,schedule_mon_wed,schedule_tue_thu,schedule_sat,schedule_sun\n";
const imp = (rows: string) => importMembers(HEAD + rows, cfg);

describe("CSV import", () => {
  it("loads the fixture and keeps IDs as text", () => {
    const r = importMembers(fixtureCsv(), cfg);
    expect(r.ok).toBe(true);
    expect(r.members).toHaveLength(15);
    expect(typeof r.members[0]!.studentId).toBe("string");
  });

  it("stores the official department name from an alias", () => {
    const r = imp("20231-00001,A B,media,Bus,yes,,,,\n");
    expect(r.members[0]!.department).toBe("Media & Production");
  });

  it("blank = unanswered, 'No classes' = answered and empty, slots = answered", () => {
    const r = imp('20231-00001,A B,HR,Bus,yes,,No classes,"1,3",2\n');
    const s = r.members[0]!.schedule;
    expect(s.monWed).toEqual({ answered: false, occupiedSlots: [] });
    expect(s.tueThu).toEqual({ answered: true, occupiedSlots: [] });
    expect(s.sat).toEqual({ answered: true, occupiedSlots: [1, 3] });
    expect(s.sun).toEqual({ answered: true, occupiedSlots: [2] });
  });

  it("rejects duplicates, bad IDs, unknown departments and out-of-range slots with line numbers", () => {
    const r = imp(
      "20231-00001,A,HR,Bus,y,,,,\n" +
        "20231-00001,B,HR,Bus,y,,,,\n" +
        "123,C,HR,Bus,y,,,,\n" +
        "20231-00003,D,Cooking,Bus,y,,,,\n" +
        "20231-00004,E,HR,Bus,y,5,,4,\n",
    );
    expect(r.ok).toBe(false);
    expect(r.members).toHaveLength(0);
    const all = r.errors.join("\n");
    expect(all).toMatch(/Line 3: duplicate student ID/);
    expect(all).toMatch(/Line 4: student ID "123"/);
    expect(all).toMatch(/Line 5: unknown department/);
    expect(all).toMatch(/Line 6: .*slot 5/);
    expect(all).toMatch(/Line 6: .*slot 4/);
  });

  it("refuses a file with an acceptance-like column and no filter (mixed applicant data)", () => {
    const r = importMembers("student_id,full_name,department,commute,late_stay_original,schedule_mon_wed,schedule_tue_thu,schedule_sat,schedule_sun,status\n20231-00001,A,HR,Bus,y,,,,,rejected\n", cfg);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/mixed dataset/);
  });

  it("applies an explicit acceptance filter", () => {
    const text = "student_id,full_name,department,commute,late_stay_original,schedule_mon_wed,schedule_tue_thu,schedule_sat,schedule_sun,status\n20231-00001,A,HR,Bus,y,,,,,Accepted\n20231-00002,B,HR,Bus,y,,,,,Rejected\n";
    const r = importMembers(text, { ...cfg, acceptance: { column: "status", value: "Accepted" } });
    expect(r.ok).toBe(true);
    expect(r.members.map((m) => m.fullName)).toEqual(["A"]);
  });

  it("ignores sensitive columns and reports them", () => {
    const text = HEAD.trim() + ",cnic,dob,phone\n20231-00001,A,HR,Bus,y,,,,,42101-1234567-1,2004-01-01,0300\n";
    const r = importMembers(text, cfg);
    expect(r.ok).toBe(true);
    expect(r.ignoredColumns).toEqual(["cnic", "dob", "phone"]);
    expect(JSON.stringify(r.members)).not.toMatch(/42101|2004-01-01|0300/);
  });

  it("does not turn 'until 5 pm with advance notice' into an unconditional yes; refuses ambiguous times", () => {
    const ok = importMembers(fixtureCsv(), cfg).members.find((m) => m.studentId === "20231-10002")!;
    expect(ok.lateStay.conditions).toBe("with advance notice");
    const bad = importMembers("student_id,full_name,department,commute,late_stay_original,late_stay_until,schedule_mon_wed,schedule_tue_thu,schedule_sat,schedule_sun\n20231-00001,A,HR,Bus,y,5,,,,\n", cfg);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toMatch(/ambiguous/);
  });
});

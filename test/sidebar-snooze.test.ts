import { describe, expect, test } from "bun:test";
import { excludeWokenSessions, expiredSnoozes, snoozeUntil } from "../sidebar-snooze";

const local = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime();

describe("sidebar snooze", () => {
  test("calculates short durations", () => {
    const now = local(2026, 10, 15);
    expect(snoozeUntil(now, "1-hour")).toBe(now + 3600000);
    expect(snoozeUntil(now, "3-hours")).toBe(now + 10800000);
  });
  test("calculates next-day and weekday targets across month/year boundaries", () => {
    expect(new Date(snoozeUntil(local(2026, 12, 31), "tomorrow")).toString()).toContain("Jan 01 2027");
    expect(new Date(snoozeUntil(local(2026, 12, 31), "next-week")).toString()).toContain("Jan 04 2027");
  });
  test("weekends targets next Saturday, including on Saturday", () => {
    const result = new Date(snoozeUntil(local(2026, 10, 17), "weekends"));
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(9);
    expect(result.getDate()).toBe(24);
    expect(result.getHours()).toBe(9);
  });
  test("indefinitely sets no wake time", () => {
    expect(snoozeUntil(local(2026, 10, 15), "indefinitely")).toBeUndefined();
  });
  test("finds only expired snoozed threads with timers", () => {
    expect(expiredSnoozes({ a: { lifecycle: "snoozed", snoozeUntil: 10 }, b: { lifecycle: "snoozed" }, c: { lifecycle: "active", snoozeUntil: 1 } }, 10)).toEqual(["a"]);
  });
  test("excludes sessions woken from snooze from stale candidates", () => {
    const sessions = [{ id: "woken" }, { id: "ordinary" }];
    expect(excludeWokenSessions(sessions, new Set(["woken"]))).toEqual([{ id: "ordinary" }]);
  });
});

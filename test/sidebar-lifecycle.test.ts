import { describe, expect, test } from "bun:test";
import { isAutomaticSettleEligible, normalizeLifecycle, readLifecycle, sectionOpen, shouldReviveSettled, shouldWakeSnoozed, updateThreadLifecycle } from "../sidebar-lifecycle";

describe("sidebar lifecycle", () => {
  test("automatic settling applies only to running or unclassified chats", () => {
    expect(isAutomaticSettleEligible(undefined)).toBe(true);
    expect(isAutomaticSettleEligible("running")).toBe(true);
    expect(isAutomaticSettleEligible("pinned")).toBe(false);
    expect(isAutomaticSettleEligible("snoozed")).toBe(false);
    expect(isAutomaticSettleEligible("settled")).toBe(false);
  });

  test("normalizes missing and unknown stored lifecycle values to running", () => {
    expect(normalizeLifecycle(undefined)).toBe("running");
    expect(normalizeLifecycle("not-a-state")).toBe("running");
    expect(readLifecycle({ one: { lifecycle: "settled" } }, "one")).toBe("settled");
    expect(readLifecycle({ legacy: { lifecycle: "active" } }, "legacy")).toBe("running");
  });

  test("uses consistent section defaults", () => {
    expect(sectionOpen("left", undefined)).toBe(true);
    expect(sectionOpen("pinned", undefined)).toBe(true);
    expect(sectionOpen("needsYou", undefined)).toBe(true);
    expect(sectionOpen("running", undefined)).toBe(false);
    expect(sectionOpen("snoozed", undefined)).toBe(true);
    expect(sectionOpen("settled", undefined)).toBe(false);
    expect(sectionOpen("running", false)).toBe(false);
    expect(sectionOpen("running", true)).toBe(true);
    expect(sectionOpen("snoozed", false)).toBe(false);
  });

  test("updates lifecycle without dropping thread metadata", () => {
    const threads: Record<string, any> = {
      one: { lifecycle: "running", setupId: "custom", settledAt: "old", extra: 42 },
    };
    const original = threads.one;
    updateThreadLifecycle(threads, "one", "pinned", "fallback");
    expect(threads.one).toBe(original);
    expect(threads.one).toEqual({ lifecycle: "pinned", setupId: "custom", settledAt: "old", extra: 42 });
  });

  test("revives settled chats only while executing", () => {
    expect(shouldReviveSettled("settled", true)).toBe(true);
    expect(shouldReviveSettled("settled", false)).toBe(false);
  });

  test("does not override running, pinned, or snoozed lifecycle", () => {
    for (const lifecycle of ["running", "pinned", "snoozed"] as const) {
      expect(shouldReviveSettled(lifecycle, false)).toBe(false);
      expect(shouldReviveSettled(lifecycle, true)).toBe(false);
    }
  });

  test("missing and legacy lifecycle do not request revival", () => {
    expect(shouldReviveSettled(readLifecycle({}, "missing"), true)).toBe(false);
    expect(shouldReviveSettled(readLifecycle({ legacy: { lifecycle: "active" } }, "legacy"), true)).toBe(false);
  });

  test("wakes snoozed chats only while executing", () => {
    expect(shouldWakeSnoozed("snoozed", true)).toBe(true);
    expect(shouldWakeSnoozed("snoozed", false)).toBe(false);
    for (const lifecycle of ["running", "pinned", "settled"] as const) {
      expect(shouldWakeSnoozed(lifecycle, true)).toBe(false);
      expect(shouldWakeSnoozed(lifecycle, false)).toBe(false);
    }
    expect(shouldWakeSnoozed(readLifecycle({}, "missing"), true)).toBe(false);
  });
});

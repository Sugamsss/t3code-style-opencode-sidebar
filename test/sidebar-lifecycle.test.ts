import { describe, expect, test } from "bun:test";
import { isAutoArchiveEligible, normalizeLifecycle, readLifecycle, sectionOpen, shouldReviveArchived, shouldWakeSnoozed, updateThreadLifecycle } from "../sidebar-lifecycle";

// The lifecycle value earlier versions wrote to the state file. Named once,
// here only, so the migration stays testable without the old name coming back.
const LEGACY_ARCHIVED = "settled";

describe("sidebar lifecycle", () => {
  test("automatic archiving applies only to running or unclassified chats", () => {
    expect(isAutoArchiveEligible(undefined)).toBe(true);
    expect(isAutoArchiveEligible("running")).toBe(true);
    expect(isAutoArchiveEligible("pinned")).toBe(false);
    expect(isAutoArchiveEligible("snoozed")).toBe(false);
    expect(isAutoArchiveEligible("archived")).toBe(false);
  });

  test("normalizes missing and unknown stored lifecycle values to running", () => {
    expect(normalizeLifecycle(undefined)).toBe("running");
    expect(normalizeLifecycle("not-a-state")).toBe("running");
    expect(normalizeLifecycle("archived")).toBe("archived");
    expect(readLifecycle({ one: { lifecycle: "archived" } }, "one")).toBe("archived");
    expect(readLifecycle({ legacy: { lifecycle: "active" } }, "legacy")).toBe("running");
  });

  test("reads the legacy archived value as archived", () => {
    expect(normalizeLifecycle(LEGACY_ARCHIVED)).toBe("archived");
    expect(readLifecycle({ legacy: { lifecycle: LEGACY_ARCHIVED, archivedAt: "old" } }, "legacy")).toBe("archived");
  });

  test("uses consistent section defaults", () => {
    expect(sectionOpen("left", undefined)).toBe(true);
    expect(sectionOpen("pinned", undefined)).toBe(true);
    expect(sectionOpen("needsYou", undefined)).toBe(true);
    expect(sectionOpen("running", undefined)).toBe(false);
    expect(sectionOpen("snoozed", undefined)).toBe(true);
    expect(sectionOpen("archived", undefined)).toBe(false);
    expect(sectionOpen("running", false)).toBe(false);
    expect(sectionOpen("running", true)).toBe(true);
    expect(sectionOpen("snoozed", false)).toBe(false);
  });

  test("updates lifecycle without dropping thread metadata", () => {
    const threads: Record<string, any> = {
      one: { lifecycle: "running", setupId: "custom", archivedAt: "old", extra: 42 },
    };
    const original = threads.one;
    updateThreadLifecycle(threads, "one", "pinned", "fallback");
    expect(threads.one).toBe(original);
    expect(threads.one).toEqual({ lifecycle: "pinned", setupId: "custom", archivedAt: "old", extra: 42 });
  });

  test("revives archived chats only while executing", () => {
    expect(shouldReviveArchived("archived", true)).toBe(true);
    expect(shouldReviveArchived("archived", false)).toBe(false);
  });

  test("does not override running, pinned, or snoozed lifecycle", () => {
    for (const lifecycle of ["running", "pinned", "snoozed"] as const) {
      expect(shouldReviveArchived(lifecycle, false)).toBe(false);
      expect(shouldReviveArchived(lifecycle, true)).toBe(false);
    }
  });

  test("missing and legacy lifecycle do not request revival", () => {
    expect(shouldReviveArchived(readLifecycle({}, "missing"), true)).toBe(false);
    expect(shouldReviveArchived(readLifecycle({ legacy: { lifecycle: "active" } }, "legacy"), true)).toBe(false);
  });

  test("legacy archived lifecycle revives when execution resumes", () => {
    const lifecycle = readLifecycle({ legacy: { lifecycle: LEGACY_ARCHIVED, archivedAt: "old" } }, "legacy");
    expect(shouldReviveArchived(lifecycle, true)).toBe(true);
  });

  test("wakes snoozed chats only while executing", () => {
    expect(shouldWakeSnoozed("snoozed", true)).toBe(true);
    expect(shouldWakeSnoozed("snoozed", false)).toBe(false);
    for (const lifecycle of ["running", "pinned", "archived"] as const) {
      expect(shouldWakeSnoozed(lifecycle, true)).toBe(false);
      expect(shouldWakeSnoozed(lifecycle, false)).toBe(false);
    }
    expect(shouldWakeSnoozed(readLifecycle({}, "missing"), true)).toBe(false);
  });
});

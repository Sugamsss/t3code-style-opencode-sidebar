// @ts-nocheck — Bun supplies this test module; the repo's standalone tsc config does not.
import { describe, expect, test } from "bun:test";
import { hasLegacyArchiveState, migrateLegacyArchiveState } from "../legacy-archive";

describe("legacy archive migration", () => {
  test("rewrites lifecycle and timestamp while retaining unrelated fields", () => {
    const state = { threads: { one: { lifecycle: "settled", settledAt: 12, setupId: "custom", extra: true } } };
    expect(migrateLegacyArchiveState(state)).toBe(true);
    expect(state.threads.one).toEqual({ lifecycle: "archived", archivedAt: 12, setupId: "custom", extra: true });
  });

  test("does not overwrite a newer archived timestamp", () => {
    const state = { threads: { one: { settledAt: 12, archivedAt: 20 } } };
    expect(migrateLegacyArchiveState(state)).toBe(true);
    expect(state.threads.one).toEqual({ archivedAt: 20 });
  });

  test("moves section state only when the new key is absent", () => {
    const state: any = { settledOpen: false, archivedOpen: true };
    expect(migrateLegacyArchiveState(state)).toBe(true);
    expect(state).toEqual({ archivedOpen: true });
    const absent = { settledOpen: false };
    expect(migrateLegacyArchiveState(absent)).toBe(true);
    expect(absent).toEqual({ archivedOpen: false });
  });

  test("leaves modern stores deep-equal and is idempotent", () => {
    const modern = { threads: { one: { lifecycle: "archived", archivedAt: 4, setupId: "x" } }, archivedOpen: false };
    const snapshot = structuredClone(modern);
    expect(migrateLegacyArchiveState(modern)).toBe(false);
    expect(modern).toEqual(snapshot);
    const state = { threads: { one: { lifecycle: "settled", settledAt: 12 } }, settledOpen: true };
    expect(hasLegacyArchiveState(state)).toBe(true);
    expect(migrateLegacyArchiveState(state)).toBe(true);
    expect(hasLegacyArchiveState(state)).toBe(false);
    const migrated = structuredClone(state);
    expect(migrateLegacyArchiveState(state)).toBe(false);
    expect(state).toEqual(migrated);
  });

  test("tolerates missing, empty, null threads and non-object entries", () => {
    for (const state of [{}, { threads: {} }, { threads: null }, { threads: [null, 3, "x"] }]) {
      expect(() => migrateLegacyArchiveState(state)).not.toThrow();
      expect(hasLegacyArchiveState(state)).toBe(false);
    }
  });
});

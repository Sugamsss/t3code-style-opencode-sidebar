import { describe, expect, test } from "bun:test";
import { isCurrentSearch, nextSearchGeneration, reconcileSelection, searchRowOffset } from "../search-selection";

describe("search selection", () => {
  test("invalidates old generations and empty queries", () => {
    const generation = nextSearchGeneration(3);
    expect(isCurrentSearch(3, generation, "alpha", "alpha", false)).toBe(false);
    expect(isCurrentSearch(generation, generation, "alpha", "", false)).toBe(false);
    expect(isCurrentSearch(generation, generation, "alpha", "alpha", true)).toBe(false);
    expect(isCurrentSearch(generation, generation, "alpha", "alpha", false)).toBe(true);
  });

  test("preserves identity through reordering and picks a nearby item when removed", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(reconcileSelection(items, "b", 0)).toEqual({ index: 1, id: "b" });
    expect(reconcileSelection([{ id: "a" }, { id: "c" }], "b", 1)).toEqual({ index: 1, id: "c" });
    expect(reconcileSelection([], "b", 1)).toEqual({ index: 0, id: undefined });
  });

  test("counts both section headings and the spacer", () => {
    expect(searchRowOffset(3, 4, "current", 2)).toBe(3);
    expect(searchRowOffset(3, 4, "other", 0)).toBe(6);
    expect(searchRowOffset(0, 4, "other", 0)).toBe(2);
  });
});

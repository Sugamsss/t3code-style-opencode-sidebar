import { describe, expect, test } from "bun:test";
import { openTask } from "../task-opening";

const actions = (events: string[], visible = true, persist: (id: string, state: string) => void = () => {}) => ({
  rememberScroll: (): void => { events.push("scroll"); },
  persistLifecycle: (id: string, state: "running" | "pinned" | "snoozed" | "settled") => { events.push(`lifecycle:${id}:${state}`); persist(id, state); },
  markRead: (id: string) => events.push(`read:${id}`),
  isVisibleInFilter: () => visible,
  showPersistenceError: () => events.push("error"),
  showAllChats: () => events.push("all"),
  clearDialog: () => events.push("clear"),
  navigate: (id: string) => events.push(`navigate:${id}`),
});

describe("openTask", () => {
  test("opens the captured target without changing lifecycle", () => {
    const events: string[] = [];
    const target = { id: "first" };
    const testActions = actions(events);
    testActions.rememberScroll = () => { events.push("scroll"); target.id = "later"; };
    openTask({ target }, testActions);
    expect(events).toEqual(["scroll", "read:first", "clear", "navigate:first"]);
  });

  test("transitions, reveals filtered targets, then opens", () => {
    const events: string[] = [];
    expect(openTask({ target: { id: "hidden" }, requestedLifecycle: "running" }, actions(events, false))).toBe(true);
    expect(events).toEqual(["scroll", "lifecycle:hidden:running", "read:hidden", "all", "clear", "navigate:hidden"]);
  });

  test("does not navigate or change filter when lifecycle persistence fails", () => {
    const events: string[] = [];
    const result = openTask({ target: { id: "kept" }, requestedLifecycle: "running" }, actions(events, false, () => { throw new Error("disk full"); }));
    expect(result).toBe(false);
    expect(events).toEqual(["scroll", "lifecycle:kept:running", "error"]);
  });
});

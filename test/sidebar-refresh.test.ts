import { describe, expect, test } from "bun:test";
import { applyRefreshEvent, commitRefresh, createRefreshState } from "../sidebar-refresh";

const session = (id: string, title: string, updated = 1) => ({ id, title, time: { updated } });

describe("sidebar refresh reconciliation", () => {
  test("keeps a newer rename when an older walk completes", () => {
    const state = createRefreshState([session("a", "old")]);
    const started = state.revision;
    applyRefreshEvent(state, "session.renamed", { data: { sessionID: "a", title: "new" } });
    expect(commitRefresh(state, [session("a", "old")], started)).toEqual([session("a", "new")]);
  });

  test("does not resurrect a delete during pagination", () => {
    const state = createRefreshState([session("a", "one"), session("b", "two")]);
    const started = state.revision;
    applyRefreshEvent(state, "session.deleted", { data: { sessionID: "a" } });
    expect(commitRefresh(state, [session("a", "one"), session("b", "two")], started).map((x) => x.id)).toEqual(["b"]);
  });

  test("preserves stable objects for untouched records and merges activity", () => {
    const original = session("a", "one");
    const state = createRefreshState([original]);
    applyRefreshEvent(state, "session.updated", { data: { sessionID: "a", time: { updated: 9 } } });
    const result = commitRefresh(state, [session("a", "one", 2)], 0);
    expect(result[0]).not.toBe(original);
    expect(result[0].time.updated).toBe(9);
  });

  test("retains object identity when a walk leaves a record unchanged", () => {
    const original = session("a", "one");
    const state = createRefreshState([original]);
    expect(commitRefresh(state, [session("a", "one")], 0)[0]).toBe(original);
  });

  test("accepts the host event shape for a newly created session", () => {
    const state = createRefreshState([]);
    applyRefreshEvent(state, "session.created", {
      properties: { sessionID: "a", info: session("a", "new") },
    });
    expect([...state.records.values()]).toEqual([session("a", "new")]);
  });

  test("keeps the record reference for a no-op update", () => {
    const original = session("a", "same");
    const state = createRefreshState([original]);
    applyRefreshEvent(state, "session.updated", { data: original });
    expect(state.records.get("a")).toBe(original);
  });

  test("does not remove known records from an incomplete walk when caller skips commit", () => {
    const state = createRefreshState([session("a", "one"), session("b", "two")]);
    expect([...state.records.keys()]).toEqual(["a", "b"]);
  });
});

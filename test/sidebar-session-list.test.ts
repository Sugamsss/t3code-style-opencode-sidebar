import { describe, expect, test } from "bun:test";
import { updateSessionList } from "../sidebar-session-list";

const session = (id: string, updated: number, title = id) => ({ id, title, time: { updated } });

describe("updateSessionList", () => {
  test("replaces a renamed session in place", () => {
    const first = session("first", 30);
    const second = session("second", 20);
    const third = session("third", 10);
    const renamed = session("second", 20, "Renamed");

    const result = updateSessionList([first, second, third], "second", renamed, "upsert");

    expect(result).toEqual([first, renamed, third]);
    expect(result[0]).toBe(first);
    expect(result[2]).toBe(third);
  });

  test("moves only the changed session when its updated time changes", () => {
    const first = session("first", 30);
    const second = session("second", 20);
    const third = session("third", 10);

    const result = updateSessionList([first, second, third], "third", session("third", 40), "upsert");

    expect(result.map((item) => item.id)).toEqual(["third", "first", "second"]);
    expect(result[1]).toBe(first);
    expect(result[2]).toBe(second);
  });

  test("inserts new sessions in updated-time order", () => {
    const first = session("first", 30);
    const third = session("third", 10);

    const result = updateSessionList([first, third], "second", session("second", 20), "upsert");

    expect(result.map((item) => item.id)).toEqual(["first", "second", "third"]);
  });

  test("removes only the requested session", () => {
    const first = session("first", 30);
    const second = session("second", 20);
    const third = session("third", 10);

    const result = updateSessionList([first, second, third], "second", undefined, "delete");

    expect(result).toEqual([first, third]);
    expect(result[0]).toBe(first);
    expect(result[1]).toBe(third);
  });
});

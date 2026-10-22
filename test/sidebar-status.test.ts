import { afterEach, describe, expect, test } from "bun:test";
import { batch, createRoot, createSignal } from "solid-js";
import { createSidebarStatus, statusColors } from "../sidebar-status";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
const session = (id = "root", parentID?: string, idle = 10, outcome = "succeeded") => ({ id, parentID, outcome, time: { idle, viewed: 0, updated: idle } });
function fixture(initial = [session()], saved: Record<string, number> = {}, sync?: (kind: string, id: string) => Promise<unknown>) {
  const [listed, setListed] = createSignal(initial);
  const [native, setNative] = createSignal<typeof initial>([]);
  const [running, setRunning] = createSignal<string[]>([]);
  const [permissions, setPermissions] = createSignal<Record<string, unknown[]>>({});
  const [forms, setForms] = createSignal<Record<string, unknown[]>>({});
  const [route, setRoute] = createSignal<{type: string; sessionID?: string}>({ type: "home" });
  const listeners = new Map<string, Set<(event: any) => void>>();
  const persisted = { ...saved };
  const hydrations: string[] = [];
  const requests = (kind: string, read: typeof permissions) => ({
    list: (id: string) => read()[id],
     sync: (id: string) => { hydrations.push(`${kind}:${id}`); return sync?.(kind, id) || Promise.resolve(); },
    invalidate: () => {},
  });
  const ctx = { data: {
    on: (type: string, listener: (event: any) => void) => {
      const items = listeners.get(type) || new Set(); items.add(listener); listeners.set(type, items);
      return () => { items.delete(listener); };
    },
    session: { list: native, status: (id: string) => running().includes(id) ? "running" : "idle",
      permission: requests("permission", permissions), form: requests("form", forms) },
  }, ui: { router: { current: route } } };
  const tracker = createRoot((dispose) => {
    const tracker = createSidebarStatus(ctx, listed, persisted, (id, at) => {
      if (at === undefined) delete persisted[id]; else persisted[id] = at;
    });
    cleanups.push(() => { tracker.dispose(); dispose(); });
    return tracker;
  });
  const emit = (type: string, id = "root", created = 20) => listeners.get(type)?.forEach((listener) => listener({ type, data: { sessionID: id }, created }));
  const finish = (id = "root", outcome = "succeeded", at = 20) => batch(() => {
    setRunning((ids) => ids.filter((value) => value !== id));
    emit(`session.execution.${outcome}`, id, at);
  });
  return { tracker, setListed, setNative, setRunning, setPermissions, setForms, persisted, hydrations, listeners, emit, finish,
    select: (id?: string) => setRoute(id ? { type: "session", sessionID: id } : { type: "home" }),
    status: () => tracker.status(initial[0]), root: initial[0] };
}

describe("sidebar lifecycle on the current OpenCode data API", () => {
  test("brand new idle chats are read", () => {
    const f = fixture([session("root", undefined, 0)]); expect(f.status()).toBe("read");
  });
  test("background finish turns green, opening turns grey and stays read after leaving", () => {
    const f = fixture(); f.setRunning(["root"]); expect(f.status()).toBe("active");
    f.finish(); expect(f.status()).toBe("unread"); f.select("root"); expect(f.status()).toBe("read");
    f.select(); expect(f.status()).toBe("read"); expect(f.persisted.root).toBe(20);
  });
  test("completion while already selected is read when leaving", () => {
    const f = fixture(); f.select("root"); f.setRunning(["root"]); expect(f.status()).toBe("active");
    f.finish(); f.select(); expect(f.status()).toBe("read");
  });
  test("reading during a run does not consume a later background answer", () => {
    const f = fixture(); f.setRunning(["root"]); f.select("root"); f.select(); f.finish(); expect(f.status()).toBe("unread");
  });
  test("click read wins over stale native timestamps", () => {
    const f = fixture(); f.tracker.markRead("root"); f.setNative([session()]); expect(f.status()).toBe("read");
  });
  test("persisted read watermark survives restart, newer offline completion is unread", () => {
    const f = fixture([session()], { root: 10 }); expect(f.status()).toBe("read");
    f.setListed([session("root", undefined, 30)]); expect(f.status()).toBe("unread");
  });
  test("native viewed event from another viewer consumes completion", () => {
    const f = fixture(); f.setNative([{ ...session(), time: { idle: 10, viewed: 10, updated: 10 } }]); expect(f.status()).toBe("read");
  });
  test("permissions and question forms override running and failures", () => {
    const f = fixture([session("root", undefined, 10, "failed")]); f.setRunning(["root"]);
    f.setPermissions({ root: [{}] }); expect(f.status()).toBe("attention");
    f.setPermissions({}); f.setForms({ root: [{}] }); expect(f.status()).toBe("attention");
    f.setForms({}); expect(f.status()).toBe("active");
  });
  test("multiple pending requests stay yellow until all are answered", () => {
    const f = fixture(); f.setRunning(["root"]); f.setPermissions({ root: [{}, {}] });
    f.setForms({ root: [{}] }); f.setPermissions({}); expect(f.status()).toBe("attention");
    f.setForms({}); expect(f.status()).toBe("active");
  });
  for (const outcome of ["failed", "interrupted"]) test(`${outcome} is red even when opened; a new run overrides the failure`, () => {
    const f = fixture(); f.setRunning(["root"]); f.finish("root", outcome); expect(f.status()).toBe("failed");
    f.select("root"); expect(f.status()).toBe("failed"); f.setRunning(["root"]); expect(f.status()).toBe("active");
    f.finish("root", "succeeded", 30); expect(f.status()).toBe("read"); f.select(); expect(f.status()).toBe("read");
  });
  test("retryable step failure is not a terminal run failure", () => {
    const f = fixture(); f.setRunning(["root"]); f.emit("session.step.failed"); expect(f.status()).toBe("active");
    f.finish("root", "failed"); expect(f.status()).toBe("failed");
  });
  test("late stale metadata cannot erase a just-finished failure", () => {
    const f = fixture(); f.finish("root", "failed", 30); f.setNative([session("root", undefined, 10)]);
    expect(f.status()).toBe("failed");
  });
  test("newer native completion supersedes an old cached failure", () => {
    const f = fixture(); f.finish("root", "failed", 20); f.setNative([session("root", undefined, 30)]); expect(f.status()).toBe("unread");
  });
  test("an older listed success cannot replace a newer native failure", () => {
    const f = fixture(); f.setNative([session("root", undefined, 30, "failed")]);
    f.setListed([session("root", undefined, 10)]); expect(f.status()).toBe("failed");
  });
  test("duplicate and out of order terminal events do not reopen read work", () => {
    const f = fixture(); f.finish("root", "succeeded", 30); f.tracker.markRead("root");
    f.finish("root", "failed", 20); f.finish("root", "succeeded", 30); expect(f.status()).toBe("read");
  });
  test("terminal listeners are removed on disposal", () => {
    const f = fixture(); f.tracker.dispose(); expect([...f.listeners.values()].every((items) => items.size === 0)).toBe(true);
  });
});

describe("background subagents belong to their parent task", () => {
  const tree = () => [session(), session("child", "root", 0), session("grandchild", "child", 0), session("other", undefined, 0)];
  test("parent stays running while any child or grandchild is running", () => {
    const f = fixture(tree()); f.setRunning(["root", "child", "grandchild"]); f.finish("root"); expect(f.status()).toBe("active");
    f.finish("child", "succeeded", 30); expect(f.status()).toBe("active");
    f.finish("grandchild", "succeeded", 40); expect(f.status()).toBe("unread");
    f.select("root"); f.select(); expect(f.status()).toBe("read"); expect(f.persisted.root).toBe(40);
  });
  test("a child starting after the parent's completion restores running", () => {
    const f = fixture(tree()); f.finish(); f.setRunning(["child"]); expect(f.status()).toBe("active");
  });
  test("last child finishing while the parent is selected stays read", () => {
    const f = fixture(tree()); f.select("root"); f.setRunning(["child"]); f.finish("child", "succeeded", 30);
    f.select(); expect(f.status()).toBe("read"); expect(f.persisted.root).toBe(30);
  });
  test("opening the parent while a child runs does not consume its future background completion", () => {
    const f = fixture(tree()); f.setRunning(["child"]); f.select("root"); f.select();
    f.finish("child", "succeeded", 30); expect(f.status()).toBe("unread");
  });
  test("subagent questions and permissions pause the parent scanner", () => {
    const f = fixture(tree()); f.setRunning(["grandchild"]); f.setForms({ grandchild: [{}] }); expect(f.status()).toBe("attention");
    f.setForms({}); f.setPermissions({ child: [{}] }); expect(f.status()).toBe("attention");
    f.setPermissions({}); expect(f.status()).toBe("active");
  });
  test("background running overrides parent failure, which returns once child finishes", () => {
    const f = fixture(tree()); f.setRunning(["child"]); f.finish("root", "failed"); expect(f.status()).toBe("active");
    f.finish("child", "succeeded", 30); expect(f.status()).toBe("failed");
  });
  test("a new child failure is red; an old child failure does not poison a successful new parent turn", () => {
    const f = fixture(tree()); f.finish("child", "failed", 20); expect(f.status()).toBe("failed");
    f.finish("root", "succeeded", 30); expect(f.status()).toBe("unread");
  });
  test("unrelated sessions do not affect this task", () => {
    const f = fixture(tree()); f.setRunning(["other"]); f.setForms({ other: [{}] }); expect(f.status()).toBe("unread");
  });
  test("native newly created descendants are included before the sidebar list refresh", () => {
    const f = fixture(); f.setNative([session("child", "root", 0)]); f.setRunning(["child"]); expect(f.status()).toBe("active");
  });
  test("loaded children are included even if the native session list omits them", () => {
    const f = fixture(tree()); f.setNative([session()]); f.setRunning(["grandchild"]); expect(f.status()).toBe("active");
  });
  test("pending request hydration covers running descendants and reconnects", async () => {
    const f = fixture(tree()); f.setRunning(["grandchild"]); await Promise.resolve(); await Promise.resolve();
    expect(f.hydrations).toEqual(["permission:grandchild", "form:grandchild"]);
    f.emit("server.connected"); await Promise.resolve(); await Promise.resolve();
    expect(f.hydrations).toHaveLength(4);
  });
  test("reconnect during pending hydration queues one current-generation follow-up", async () => {
    const deferreds: (() => void)[] = [];
    const f = fixture([session()], {}, () => new Promise<void>((resolve) => deferreds.push(resolve)));
    f.setRunning(["root"]); await Promise.resolve();
    expect(f.hydrations).toEqual(["permission:root", "form:root"]);
    f.emit("server.connected"); f.emit("server.connected"); await Promise.resolve();
    expect(f.hydrations).toHaveLength(2);
    deferreds.splice(0).forEach((resolve) => resolve()); await Promise.resolve(); await Promise.resolve();
    expect(f.hydrations).toHaveLength(4);
    deferreds.splice(0).forEach((resolve) => resolve());
  });
  test("permission and form failures retry independently", async () => {
    const attempts = { permission: 0, form: 0 };
    const f = fixture([session()], {}, (kind) => {
      attempts[kind as "permission" | "form"] += 1;
      return kind === "permission" && attempts.permission === 1
        ? Promise.reject(new Error("permission unavailable")) : Promise.resolve();
    });
    f.setRunning(["root"]); await Promise.resolve(); await Promise.resolve();
    expect(attempts).toEqual({ permission: 1, form: 1 });
    // The failed branch is retried on its own; the successful form branch is
    // not needlessly requested again.
    await new Promise((resolve) => setTimeout(resolve, 520)); await Promise.resolve(); await Promise.resolve();
    expect(attempts).toEqual({ permission: 2, form: 1 });
  });
  test("failed branches stop after the bounded retry budget", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const timers: (() => void)[] = [];
    globalThis.setTimeout = ((callback: TimerHandler) => {
      timers.push(callback as () => void);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    try {
      const f = fixture([session()], {}, () => Promise.reject(new Error("offline")));
      f.setRunning(["root"]); await Promise.resolve(); await Promise.resolve();
      for (let attempt = 1; attempt < 8; attempt += 1) {
        timers.splice(0).forEach((callback) => callback());
        await Promise.resolve(); await Promise.resolve();
      }
      expect(f.hydrations.filter((id) => id === "permission:root")).toHaveLength(8);
      expect(f.hydrations.filter((id) => id === "form:root")).toHaveLength(8);
      f.tracker.dispose();
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
  test("disposal ignores obsolete completions", async () => {
    let resolveRequest!: () => void;
    const f = fixture([session()], {}, () => new Promise<void>((resolve) => { resolveRequest = resolve; }));
    f.setRunning(["root"]); await Promise.resolve();
    f.tracker.dispose(); resolveRequest(); await Promise.resolve(); await Promise.resolve();
    expect(f.hydrations).toHaveLength(2);
  });
  test("malformed cyclic ancestry cannot hang the sidebar", () => {
    const f = fixture([session("root", "child"), session("child", "root")]); expect(f.status()).toBe("unread");
  });
});

test("status rail uses the exact specified static colors", () => {
  expect(statusColors).toEqual({ attention: "#facc15", active: "#22c55e", failed: "#ef4444", unread: "#22c55e", read: "#9ca3af", woken: "#a78bfa" });
});

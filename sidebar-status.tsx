// Use .tsx so OpenCode binds Solid imports to its embedded reactive runtime.
import { createEffect, createMemo, createSignal, untrack } from "solid-js";

export type SidebarStatus = "attention" | "active" | "failed" | "unread" | "read" | "woken";
export const statusColors: Record<SidebarStatus, string> = {
  attention: "#facc15",
  active: "#22c55e",
  failed: "#ef4444",
  unread: "#22c55e",
  read: "#9ca3af",
  woken: "#a78bfa",
};

type Session = {
  id: string;
  parentID?: string;
  outcome?: string;
  time?: { idle?: number; viewed?: number; updated?: number };
};
type Completion = { at: number; outcome: string };
type Accessor<T> = () => T;
type Context = {
  data: {
    on: (type: string, listener: (event: any) => void) => () => void;
    session: {
      list: () => Session[];
      status: (id: string) => string;
      permission: { list: (id: string) => unknown[] | undefined; sync: (id: string) => Promise<unknown>; invalidate: (id: string) => void };
      form: { list: (id: string) => unknown[] | undefined; sync: (id: string) => Promise<unknown>; invalidate: (id: string) => void };
    };
  };
  ui: { router: { current: () => { type: string; sessionID?: string } } };
};

// Running and attention come from the host's shared, reconnecting event feed.
// Only completion watermarks are local: they bridge the host's async metadata
// refresh and remember reading a task after a background descendant finishes.
export function createSidebarStatus(
  ctx: Context,
  listed: Accessor<Session[]>,
  savedViewed: Record<string, number>,
  persistViewed: (id: string, at: number | undefined) => void,
) {
  const [completed, setCompleted] = createSignal<Record<string, Completion>>({});
  const [viewed, setViewed] = createSignal({ ...savedViewed });
  let disposed = false;
  const selected = () => {
    const route = ctx.ui.router.current();
    return route.type === "session" ? route.sessionID : undefined;
  };
  const sessions = createMemo(() => {
    const result = new Map<string, Session>();
    for (const session of [...listed(), ...ctx.data.session.list()]) {
      const previous = result.get(session.id);
      const newer = previous && (previous.time?.idle || 0) > (session.time?.idle || 0) ? previous : session;
      result.set(session.id, {
        ...previous, ...session, outcome: newer.outcome,
        time: { ...previous?.time, ...session.time, idle: newer.time?.idle,
          viewed: Math.max(previous?.time?.viewed || 0, session.time?.viewed || 0) },
      });
    }
    for (const [id, completion] of Object.entries(completed())) {
      const session = result.get(id);
      if (!session || (session.time?.idle || 0) >= completion.at) continue;
      result.set(id, { ...session, outcome: completion.outcome, time: { ...session.time, idle: completion.at } });
    }
    return result;
  });
  const families = createMemo(() => {
    const result = new Map<string, Session[]>();
    const all = sessions();
    for (const session of all.values()) {
      let member: Session | undefined = session;
      const visited = new Set<string>();
      // Index every ancestor, including grandchildren, without trusting a
      // possibly incomplete native family cache or accepting parent cycles.
      while (member && !visited.has(member.id)) {
        visited.add(member.id);
        const family = result.get(member.id) || [];
        family.push(session);
        result.set(member.id, family);
        member = member.parentID ? all.get(member.parentID) : undefined;
      }
    }
    return result;
  });
  const family = (session: Session) => families().get(session.id) || [session];
  const idle = (session: Session) => Math.max(0, ...family(session).map((member) => member.time?.idle || 0));
  const isRunning = (session: Session) => family(session).some((member) => ctx.data.session.status(member.id) === "running");
  const markRead = (id: string) => {
    const session = sessions().get(id);
    if (!session) return;
    const at = idle(session);
    if (at <= (viewed()[id] || 0)) return;
    setViewed((previous) => ({ ...previous, [id]: at }));
    persistViewed(id, at);
  };
  const status = (session: Session): SidebarStatus => {
    const members = family(session);
    const root = sessions().get(session.id) || session;
    let value: SidebarStatus;
    if (members.some((member) => (ctx.data.session.permission.list(member.id)?.length || 0) > 0
      || (ctx.data.session.form.list(member.id)?.length || 0) > 0)) value = "attention";
    else if (isRunning(session)) value = "active";
    // A successful new parent turn supersedes old child failures. A child
    // failing after the parent's answer still belongs to the current task.
    else if (members.some((member) => (member.id === root.id || (member.time?.idle || 0) >= (root.time?.idle || 0))
      && ["failed", "interrupted", "stopped"].includes(member.outcome || ""))) value = "failed";
    else if (selected() === session.id) value = "read";
    else {
      const readAt = Math.max(root.time?.viewed || 0, viewed()[session.id] || 0);
      value = idle(session) > readAt ? "unread" : "read";
    }
    return value;
  };
  const forget = (id: string) => {
    setCompleted((previous) => { const next = { ...previous }; delete next[id]; return next; });
    setViewed((previous) => { const next = { ...previous }; delete next[id]; return next; });
    persistViewed(id, undefined);
    hydrated.delete(id);
    const state = hydrating?.get(id);
    state?.timers.forEach((timer) => clearTimeout(timer));
    hydrating?.delete(id);
  };
  const stops = [
    ...(["succeeded", "failed", "interrupted"] as const).map((outcome) => ctx.data.on(`session.execution.${outcome}`, (event) => {
      if (disposed) return;
      const id = event.data.sessionID;
      const at = event.created;
      if (!id || !Number.isFinite(at)) return;
      setCompleted((previous) => (previous[id]?.at || 0) >= at ? previous : { ...previous, [id]: { at, outcome } });
    })),
    ctx.data.on("session.deleted", (event) => forget(event.data.sessionID)),
  ];
  createEffect(() => {
    const id = selected();
    if (!id) return;
    // Track idle even while the same task stays selected. This also consumes
    // completions from children, including when the left sidebar is hidden.
    const session = sessions().get(id);
    if (session) idle(session);
    untrack(() => markRead(id));
  });

  // Native tabs hydrate only their own sessions. The custom sidebar covers
  // every project, so hydrate pending requests for running background tasks
  // too. The host deduplicates these requests and owns their event updates.
  const hydrated = new Set<string>();
  type Branch = "permission" | "form";
  type Hydration = {
    generation: number;
    pending: number;
    needs: Set<Branch>;
    attempts: Record<Branch, number>;
    timers: Map<Branch, ReturnType<typeof setTimeout>>;
    queuedGeneration?: number;
  };
  const hydrating = new Map<string, Hydration>();
  let generation = 0;
  const [wake, setWake] = createSignal(0);
  const branches: Branch[] = ["permission", "form"];
  const MAX_RETRIES = 8;
  stops.push(ctx.data.on("server.connected", () => {
    hydrated.clear();
    generation += 1;
    // A reconnect invalidates the old response, but does not start a second
    // request while that response is still in flight. Its retry starts
    // one, and only one, request for the newest generation.
    for (const state of hydrating.values()) {
      if (state.pending) state.queuedGeneration = generation;
    }
    setWake((value) => value + 1);
  }));
  const scheduleHydrationRetry = (id: string, state: Hydration, branch: Branch) => {
    if (disposed || state.timers.has(branch) || state.attempts[branch] >= MAX_RETRIES) return;
    const delay = Math.min(30_000, 250 * (2 ** Math.min(state.attempts[branch], 7)));
    state.timers.set(branch, setTimeout(() => {
      state.timers.delete(branch);
      if (!disposed && ctx.data.session.status(id) === "running") setWake((value) => value + 1);
    }, delay));
  };
  createEffect(() => {
    wake();
    for (const session of sessions().values()) {
      const id = session.id;
      if (ctx.data.session.status(id) !== "running") {
        hydrated.delete(id);
        const state = hydrating.get(id);
        state?.timers.forEach((timer) => clearTimeout(timer));
        hydrating.delete(id);
        continue;
      }
      let state = hydrating.get(id);
      if (!state) {
        state = { generation: -1, pending: 0, needs: new Set(branches), attempts: { permission: 0, form: 0 }, timers: new Map() };
        hydrating.set(id, state);
      }
      if (state.pending || state.timers.size) continue;
      if (state.generation !== generation) {
        state.generation = generation;
        state.needs = new Set(branches);
        state.attempts = { permission: 0, form: 0 };
        hydrated.delete(id);
      }
      if (hydrated.has(id) || !state.needs.size) continue;
      const requests = { permission: ctx.data.session.permission, form: ctx.data.session.form };
      const currentGeneration = state.generation;
      const toSync = [...state.needs].filter((branch) => state!.attempts[branch] < MAX_RETRIES);
      if (!toSync.length) continue;
      state.pending = toSync.length;
      for (const branch of toSync) {
        const request = requests[branch];
        request.invalidate(id);
        void request.sync(id).then(() => {
          const current = hydrating.get(id);
          if (!current || current.generation !== currentGeneration) return;
          current.pending -= 1;
          current.needs.delete(branch);
          current.attempts[branch] = 0;
          finishHydration(id, current);
        }, () => {
          const current = hydrating.get(id);
          if (!current || current.generation !== currentGeneration) return;
          current.pending -= 1;
          current.attempts[branch] += 1;
          // An obsolete generation is deliberately followed up as a single
          // fresh pair, rather than creating a retry timer for each branch.
          if (current.queuedGeneration === undefined) scheduleHydrationRetry(id, current, branch);
          finishHydration(id, current);
        });
      }
    }
  });
  function finishHydration(id: string, state: Hydration) {
    if (state.pending) return;
    if (state.queuedGeneration !== undefined && state.queuedGeneration !== generation) {
      state.queuedGeneration = generation;
    }
    if (state.queuedGeneration === generation) {
      state.queuedGeneration = undefined;
      state.generation = generation - 1;
      setWake((value) => value + 1);
      return;
    }
    if (!state.needs.size) hydrated.add(id);
    setWake((value) => value + 1);
  }
  return { status, isRunning, markRead, forget, dispose: () => {
    disposed = true;
    stops.forEach((stop) => stop());
    for (const state of hydrating.values()) state.timers.forEach((timer) => clearTimeout(timer));
    hydrating.clear();
  } };
}

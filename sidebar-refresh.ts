export type RefreshState<T extends { id: string }> = {
  records: Map<string, T>;
  revisions: Map<string, number>;
  tombstones: Map<string, number>;
  revision: number;
};

const MAX_TOMBSTONES = 512;
const MAX_REVISIONS = 2048;

export const createRefreshState = <T extends { id: string }>(items: T[]): RefreshState<T> => ({
  records: new Map(items.map((item) => [item.id, item])),
  revisions: new Map(),
  tombstones: new Map(),
  revision: 0,
});

const trim = (map: Map<string, number>, max: number) => {
  while (map.size > max) map.delete(map.keys().next().value!);
};

const stable = <T>(oldValue: T | undefined, nextValue: T) => {
  if (!oldValue) return nextValue;
  try {
    return JSON.stringify(oldValue) === JSON.stringify(nextValue) ? oldValue : nextValue;
  } catch {
    return nextValue;
  }
};

export const applyRefreshEvent = <T extends { id: string }>(state: RefreshState<T>, type: string, value: any) => {
  const data = value?.data || value?.properties || value || {};
  const id = data.sessionID || data.id || data.info?.id || value?.sessionID;
  if (!id) return false;
  const revision = ++state.revision;
  if (type === "session.deleted") {
    state.records.delete(id);
    state.tombstones.set(id, revision);
    state.revisions.set(id, revision);
  } else {
    const previous = state.records.get(id);
    const rawPatch = data.session || data.info || data;
    const { sessionID: _sessionID, ...patch } = rawPatch;
    if (previous) {
      const next = { ...previous, ...patch, id };
      // Preserve the record reference for no-op events. This keeps a noisy
      // host update from invalidating the sidebar when nothing changed.
      const changed = Object.keys(patch).some((key) => previous[key as keyof T] !== next[key as keyof T]);
      if (changed) state.records.set(id, next);
    }
    else if (patch.id === id || type === "session.created") state.records.set(id, { ...patch, id } as T);
    state.revisions.set(id, revision);
    state.tombstones.delete(id);
  }
  trim(state.tombstones, MAX_TOMBSTONES);
  trim(state.revisions, MAX_REVISIONS);
  return true;
};

/** Commit only a complete walk. Events received after `startedAt` always win. */
export const commitRefresh = <T extends { id: string }>(state: RefreshState<T>, pages: T[], startedAt: number) => {
  const incoming = new Map(pages.map((item) => [item.id, item]));
  const next = new Map<string, T>();
  for (const [id, item] of incoming) {
    const revision = state.revisions.get(id) || 0;
    if (revision > startedAt) {
      const current = state.records.get(id);
      if (!state.tombstones.has(id) && current) next.set(id, current);
    } else if (!state.tombstones.has(id)) next.set(id, stable(state.records.get(id), item));
  }
  // A concurrent create/update may not have appeared in the walk yet.
  for (const [id, item] of state.records) {
    if ((state.revisions.get(id) || 0) > startedAt && !state.tombstones.has(id)) next.set(id, item);
  }
  state.records = next;
  return [...next.values()];
};

export const refreshSnapshot = <T extends { id: string }>(state: RefreshState<T>) => [...state.records.values()];

// Migrates pre-rename archive fields in persisted state. Delete once no state files predate the rename.
export const LEGACY_ARCHIVED = "settled";

/** True when a loaded store still carries pre-rename archive data. */
export const hasLegacyArchiveState = (state: any): boolean => {
  if (!state || typeof state !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(state, "settledOpen")) return true;
  if (!state.threads || typeof state.threads !== "object") return false;
  return Object.values(state.threads).some((thread: any) => {
    if (!thread || typeof thread !== "object") return false;
    return thread.lifecycle === LEGACY_ARCHIVED || Object.prototype.hasOwnProperty.call(thread, "settledAt");
  });
};

/** Rewrite pre-rename archive data in place. Returns true when it changed anything. */
export const migrateLegacyArchiveState = (draft: any): boolean => {
  if (!draft || typeof draft !== "object") return false;
  let changed = false;
  if (draft.threads && typeof draft.threads === "object") {
    for (const thread of Object.values(draft.threads) as any[]) {
      if (!thread || typeof thread !== "object") continue;
      if (thread.lifecycle === LEGACY_ARCHIVED) { thread.lifecycle = "archived"; changed = true; }
      if (Object.prototype.hasOwnProperty.call(thread, "settledAt")) {
        if (thread.archivedAt === undefined) thread.archivedAt = thread.settledAt;
        delete thread.settledAt;
        changed = true;
      }
    }
  }
  if (Object.prototype.hasOwnProperty.call(draft, "settledOpen")) {
    if (draft.archivedOpen === undefined) draft.archivedOpen = draft.settledOpen;
    delete draft.settledOpen;
    changed = true;
  }
  return changed;
};

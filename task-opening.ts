export type TaskLifecycle = "running" | "pinned" | "snoozed" | "settled";

export type TaskOpenRequest = {
  target: { id: string };
  requestedLifecycle?: TaskLifecycle;
};

export type TaskOpenActions = {
  rememberScroll: (beforeNavigation: boolean) => void;
  persistLifecycle: (sessionID: string, lifecycle: TaskLifecycle) => void;
  markRead: (sessionID: string) => void;
  isVisibleInFilter: (target: TaskOpenRequest["target"]) => boolean;
  showPersistenceError: (error: unknown) => void;
  showAllChats: () => void;
  clearDialog: () => void;
  navigate: (sessionID: string) => void;
};

/** Open a captured task through the same path for rows, search, and wake actions. */
export const openTask = (request: TaskOpenRequest, actions: TaskOpenActions): boolean => {
  const target = request.target;
  const sessionID = target.id;
  actions.rememberScroll(true);

  if (request.requestedLifecycle !== undefined) {
    try {
      // The host storage contract is synchronous. Do not continue if it throws.
      actions.persistLifecycle(sessionID, request.requestedLifecycle);
    } catch (error) {
      actions.showPersistenceError(error);
      return false;
    }
  }

  actions.markRead(sessionID);
  if (!actions.isVisibleInFilter(target)) actions.showAllChats();
  actions.clearDialog();
  actions.navigate(sessionID);
  return true;
};

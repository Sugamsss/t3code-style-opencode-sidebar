export type SidebarLifecycle = "running" | "pinned" | "snoozed" | "settled";

const lifecycleValues = new Set<SidebarLifecycle>(["running", "pinned", "snoozed", "settled"]);

/** Read the finite, user-owned lifecycle state without guessing from runtime metadata. */
export const normalizeLifecycle = (value: unknown): SidebarLifecycle =>
  value === "active" ? "running"
    : typeof value === "string" && lifecycleValues.has(value as SidebarLifecycle)
      ? value as SidebarLifecycle
      : "running";

export const readLifecycle = (threads: Record<string, any> | undefined, sessionID: string): SidebarLifecycle =>
  normalizeLifecycle(threads?.[sessionID]?.lifecycle);

/** Update only lifecycle metadata; existing setup and unrelated fields are retained. */
export const updateThreadLifecycle = (
  threads: Record<string, any>, sessionID: string, lifecycle: SidebarLifecycle, fallbackSetupId?: string,
) => {
  const item = threads[sessionID] || { lifecycle: "running", setupId: fallbackSetupId };
  item.lifecycle = lifecycle;
  threads[sessionID] = item;
  return item;
};

export type SidebarSection = "left" | "pinned" | "running" | "snoozed" | "settled";
const sectionDefaults: Record<SidebarSection, boolean> = {
  left: true,
  pinned: true,
  running: true,
  snoozed: true,
  settled: false,
};

export const sectionOpen = (section: SidebarSection, value: unknown): boolean =>
  value === undefined ? sectionDefaults[section] : value === true;

/** Automatic settling applies to unclassified or explicitly running chats. */
export const isAutomaticSettleEligible = (lifecycle: SidebarLifecycle | undefined) =>
  lifecycle === undefined || lifecycle === "running";

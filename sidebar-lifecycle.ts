export type SidebarLifecycle = "running" | "pinned" | "snoozed" | "archived";

const lifecycleValues = new Set<SidebarLifecycle>(["running", "pinned", "snoozed", "archived"]);

/** Read the finite, user-owned lifecycle state without guessing from runtime metadata. */
export const normalizeLifecycle = (value: unknown): SidebarLifecycle =>
  value === "active" ? "running"
    // "settled" is the pre-rename state-file value; read it as archived.
    : value === "settled" ? "archived"
    : typeof value === "string" && lifecycleValues.has(value as SidebarLifecycle)
      ? value as SidebarLifecycle
      : "running";

export const readLifecycle = (threads: Record<string, any> | undefined, sessionID: string): SidebarLifecycle =>
  normalizeLifecycle(threads?.[sessionID]?.lifecycle);

/** The archive may hold finished work, never live work. */
export const shouldReviveArchived = (lifecycle: SidebarLifecycle, executing: boolean) =>
  lifecycle === "archived" && executing;

export const shouldWakeSnoozed = (lifecycle: SidebarLifecycle, executing: boolean): boolean =>
  lifecycle === "snoozed" && executing;

/** Update only lifecycle metadata; existing setup and unrelated fields are retained. */
export const updateThreadLifecycle = (
  threads: Record<string, any>, sessionID: string, lifecycle: SidebarLifecycle, fallbackSetupId?: string,
) => {
  const item = threads[sessionID] || { lifecycle: "running", setupId: fallbackSetupId };
  item.lifecycle = lifecycle;
  threads[sessionID] = item;
  return item;
};

export type SidebarSection = "left" | "pinned" | "needsYou" | "running" | "snoozed" | "archived";
const sectionDefaults: Record<SidebarSection, boolean> = {
  left: true,
  pinned: true,
  needsYou: true,
  running: false,
  snoozed: true,
  archived: false,
};

export const sectionOpen = (section: SidebarSection, value: unknown): boolean =>
  value === undefined ? sectionDefaults[section] : value === true;

/** Automatic archiving applies to unclassified or explicitly running chats. */
export const isAutoArchiveEligible = (lifecycle: SidebarLifecycle | undefined) =>
  lifecycle === undefined || lifecycle === "running";

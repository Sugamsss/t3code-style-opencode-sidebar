export type SnoozeOption = "1-hour" | "3-hours" | "tomorrow" | "weekends" | "next-week" | "indefinitely";

/** Return the local-time wake timestamp for a snooze choice. `undefined` means no timer: wake only by hand. */
export const snoozeUntil = (now: number, option: SnoozeOption): number | undefined => {
  if (option === "indefinitely") return undefined;
  if (option === "1-hour") return now + 60 * 60 * 1000;
  if (option === "3-hours") return now + 180 * 60 * 1000;

  const date = new Date(now);
  date.setHours(9, 0, 0, 0);
  if (option === "tomorrow") date.setDate(date.getDate() + 1);
  else if (option === "weekends") {
    const days = (6 - date.getDay() + 7) % 7 || 7;
    date.setDate(date.getDate() + days);
  } else {
    const days = (8 - date.getDay()) % 7 || 7;
    date.setDate(date.getDate() + days);
  }
  return date.getTime();
};

export const expiredSnoozes = (threads: Record<string, any> | undefined, now: number): string[] =>
  Object.entries(threads || {})
    .filter(([, thread]) => thread?.lifecycle === "snoozed" && typeof thread.snoozeUntil === "number" && thread.snoozeUntil <= now)
    .map(([id]) => id);

/** Exclude snooze wakes from the automatic stale-thread archive sweep. */
export const excludeWokenSessions = <T extends { id: string }>(sessions: T[], woken: ReadonlySet<string>): T[] =>
  sessions.filter((session) => !woken.has(session.id));

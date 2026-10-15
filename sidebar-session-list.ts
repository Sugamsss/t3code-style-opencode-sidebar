type SessionLike = {
  id: string;
  time?: { updated?: number };
};

const updatedAt = (session: SessionLike) => session.time?.updated || 0;

/**
 * Applies one session-list change without sorting or rebuilding unrelated records.
 * The list is kept in descending updated-time order.
 */
export const updateSessionList = <T extends SessionLike>(
  items: T[],
  id: string,
  next: T | undefined,
  mode: "upsert" | "delete",
) => {
  const index = items.findIndex((item) => item.id === id);

  if (mode === "delete") {
    if (index < 0) return items;
    return [...items.slice(0, index), ...items.slice(index + 1)];
  }

  if (!next) return items;
  if (index >= 0 && items[index] === next) return items;

  // A rename normally keeps its timestamp. Preserve its exact position and
  // every other item reference so the sidebar only has one changed row.
  if (index >= 0 && updatedAt(items[index]) === updatedAt(next)) {
    const result = items.slice();
    result[index] = next;
    return result;
  }

  const withoutCurrent = index < 0
    ? items
    : [...items.slice(0, index), ...items.slice(index + 1)];
  const timestamp = updatedAt(next);
  let insertion = 0;
  while (insertion < withoutCurrent.length && updatedAt(withoutCurrent[insertion]) >= timestamp) insertion++;
  return [
    ...withoutCurrent.slice(0, insertion),
    next,
    ...withoutCurrent.slice(insertion),
  ];
};

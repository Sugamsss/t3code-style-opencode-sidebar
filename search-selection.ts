export type SearchItem = { id: string };

/** Returns a generation that invalidates every request started earlier. */
export const nextSearchGeneration = (generation: number) => generation + 1;

export const isCurrentSearch = (request: number, generation: number, requestQuery: string, currentQuery: string, closed: boolean) =>
  !closed && request === generation && requestQuery === currentQuery && currentQuery.trim().length > 0;

/** Keep selection attached to an item when results are enriched or reordered. */
export const reconcileSelection = <T extends SearchItem>(items: T[], selectedID: string | undefined, previousIndex = 0) => {
  if (items.length === 0) return { index: 0, id: undefined as string | undefined };
  const byID = selectedID ? items.findIndex((item) => item.id === selectedID) : -1;
  const index = byID >= 0 ? byID : Math.min(Math.max(previousIndex, 0), items.length - 1);
  return { index, id: items[index]?.id };
};

export const searchRowOffset = (currentCount: number, otherCount: number, section: "current" | "other", sectionIndex: number) => {
  if (section === "current") return 1 + sectionIndex; // THIS PROJECT heading
  return (currentCount > 0 ? 1 + currentCount : 0) + 1 + 1 + sectionIndex; // spacer + OTHER PROJECTS heading + result
};

export const GLYPHS = {
  add: "+",
  search: "⌕",
  close: "×",
  delete: "×",

  archive: "✓",
  restore: "○",

  pin: "●",
  unpin: "○",
  snooze: "◌",
  wake: "○",

  disclosure: {
    open: "▾",
    closed: "▸",
    select: "⌄",
  },

  indicator: {
    running: "⬝",
    current: "●",
    project: "◌",
    noProject: "○",
    allProjects: "▦",
    noFilter: "⊘",
    group: "◆",
  },

  pointer: "❯",

  shortcut: {
    pin: "p",
    snooze: "s",
    archive: "t",
    delete: "x",
    unpin: "u",
    wake: "w",
    restore: "u",
  },
} as const;

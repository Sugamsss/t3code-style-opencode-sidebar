export const GLYPHS = {
  add: "+",
  search: "⌕",
  close: "×",
  delete: "×",

  settle: "✓",
  unsettle: "○",

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
    settle: "t",
    delete: "x",
    unpin: "u",
    wake: "w",
    unsettle: "u",
  },
} as const;

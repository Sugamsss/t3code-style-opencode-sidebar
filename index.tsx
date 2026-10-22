/** @jsxImportSource @opentui/solid */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import { createSidebarStatus, statusColors } from "./sidebar-status";
import { scannerCells, scannerFrameAt, scannerFrameCount, scannerShouldAnimate, scannerWidth } from "./scanner-frames";
import { isAutoArchiveEligible, readLifecycle, sectionOpen, shouldReviveArchived, shouldWakeSnoozed, updateThreadLifecycle } from "./sidebar-lifecycle";
import { hasLegacyArchiveState, migrateLegacyArchiveState } from "./legacy-archive";
import { applyRefreshEvent, commitRefresh, createRefreshState, refreshSnapshot } from "./sidebar-refresh";
import { updateSessionList } from "./sidebar-session-list";
import { excludeWokenSessions, expiredSnoozes, snoozeUntil, type SnoozeOption } from "./sidebar-snooze";
import { isCurrentSearch, nextSearchGeneration, reconcileSelection, searchRowOffset } from "./search-selection";
import { createProjectResolver, effectiveProjectFilter, normalizeProjectPath, type ProjectEntry, type ProjectGroup } from "./project-catalog";
import { buildProjectOptions, resolveProjectDestination } from "./project-picker";
import { openTask as openTaskThroughCommonPath } from "./task-opening";
import { GLYPHS } from "./sidebar-glyphs";

type ColorPath = readonly string[];
type Setup = {
  id: string;
  name: string;
  icon: string;
  leadAgent: string;
  scope: "global" | "project";
  prompt?: string;
  agents?: string[];
  skills?: string[];
  tools?: string[];
  isBuiltin?: boolean;
  dirPath?: string;
};

type Lifecycle = "running" | "pinned" | "snoozed" | "archived";

/**
 * The small, intentionally boring glyph vocabulary used by the sidebar.
 * Keep these single-cell in the OpenCode terminal wherever the font permits;
 * action shortcuts remain ASCII because they are keys, not decoration.
 */
export const glyphs = {
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
  disclosure: { open: "▾", closed: "▸", select: "⌄" },
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
  shortcut: { pin: "p", snooze: "s", archive: "t", delete: "x", unpin: "u", wake: "w", restore: "u" },
} as const;

const builtin: Setup[] = [
  {
    id: "software-factory",
    name: "Software Factory",
    icon: "🤖",
    leadAgent: "Product Manager",
    scope: "global",
    prompt: "Work as a pragmatic software factory team led by the Product Manager. Keep changes focused, tested, and easy to maintain. Prefer the smallest coherent fix, fit existing patterns, and verify real behavior before calling work done.",
    agents: [
      "Product Manager",
      "Tech Lead",
      "Design Lead",
      "Designer",
      "Backend Guy",
      "Frontend Guy",
      "Research Lead",
      "Researcher",
      "general",
      "explore",
    ],
    skills: ["computer-use", "playwright-cli"],
    tools: ["terminal", "filesystem"],
    isBuiltin: true,
  },
  {
    id: "default",
    name: "Default",
    icon: "⚙️",
    leadAgent: "build",
    scope: "global",
    prompt: "",
    agents: [],
    skills: [],
    tools: [],
    isBuiltin: true,
  },
];

const projectGroupSpecs = [
  { id: "production", name: "PRODUCTION", icon: "◈", root: join(homedir(), "0. Production Projects") },
  { id: "opencode", name: "OPENCODE", icon: "⬡", root: join(homedir(), "OpenCode plugins") },
  { id: "personal", name: "PERSONAL", icon: "◇", root: join(homedir(), "1. Personal Projects") },
  { id: "automation", name: "AUTOMATIONEDGE", icon: "◆", root: join(homedir(), "2. AutomationEdge Projects") },
  { id: "portfolio", name: "PORTFOLIO", icon: "✦", root: join(homedir(), "3. Portfolio & Project Proofs") },
] as const;

const noProject: ProjectEntry = {
  id: "__no_project__",
  name: "No project",
  path: homedir(),
  groupId: "none",
};

const projectSignals = [
  ".git", ".opencode", ".github", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile",
  "Package.swift", "src", "app", "frontend", "backend", "web", "tests", "docs", "scripts", "assets",
  "infrastructure", "Velocity.xcodeproj", "README.md",
];

const isProjectRoot = (path: string) => {
  if (!existsSync(path)) return false;
  if (projectSignals.some((signal) => existsSync(join(path, signal)))) return true;
  try {
    return readdirSync(path).some((name) => name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace"));
  } catch {
    return false;
  }
};

const readProjects = (): ProjectGroup[] => {
  const seen = new Set<string>();
  return projectGroupSpecs.map((group) => {
    const projects: ProjectEntry[] = [];
    if (!existsSync(group.root)) return { ...group, projects };

    const add = (path: string) => {
       const normalized = normalizeProjectPath(path);
       if (!isProjectRoot(path) || seen.has(normalized)) return;
       seen.add(normalized);
       projects.push({ id: normalized, name: basename(normalized), path: normalized, groupId: group.id, available: true });
    };

    let children: any[] = [];
    try {
      children = readdirSync(group.root, { withFileTypes: true }) as any[];
    } catch {
      return { ...group, projects };
    }

    for (const child of children) {
      if (!child.isDirectory?.() || child.name.startsWith(".")) continue;
      const childPath = join(group.root, child.name);
      if (isProjectRoot(childPath)) {
        add(childPath);
        continue;
      }

      // A few workspace folders are categories themselves (for example
      // "Vardhan Traders Projects" and "Interesting Builds"). Include their
      // actual project folders one level deeper without flattening the UI.
      let nested: any[] = [];
      try {
        nested = readdirSync(childPath, { withFileTypes: true }) as any[];
      } catch {
        continue;
      }
      for (const item of nested) {
        if (!item.isDirectory?.() || item.name.startsWith(".")) continue;
        add(join(childPath, item.name));
      }
    }

    projects.sort((a, b) => a.name.localeCompare(b.name));
    return { ...group, projects };
  });
};

const readSetups = (directory: string | undefined): Setup[] => {
  const roots = [
    { path: join(homedir(), ".config", "opencode", "setups"), scope: "global" as const },
    { path: join(directory || process.cwd(), ".opencode", "setups"), scope: "project" as const },
  ];
  const found = new Map(builtin.map((setup) => [setup.id, setup]));

  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    for (const name of readdirSync(root.path)) {
      const dirPath = join(root.path, name);
      const path = join(dirPath, "setup.json");
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      try {
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (!value?.id || !value?.name || !value?.leadAgent) continue;
        const isBuiltin = value.id === "software-factory" || value.id === "default";
        found.set(value.id, {
          id: value.id,
          name: value.name,
          icon: value.icon || "✦",
          leadAgent: value.leadAgent,
          scope: root.scope,
          prompt: typeof value.prompt === "string" ? value.prompt : undefined,
          agents: Array.isArray(value.agents) ? value.agents.filter((a: unknown) => typeof a === "string") : undefined,
          skills: Array.isArray(value.skills) ? value.skills.filter((s: unknown) => typeof s === "string") : undefined,
          tools: Array.isArray(value.tools) ? value.tools.filter((t: unknown) => typeof t === "string") : undefined,
          isBuiltin,
          dirPath,
        });
      } catch {
        // One malformed setup must not prevent OpenCode from starting.
      }
    }
  }

  return [...found.values()];
};

// Emoji icons take 2 terminal cells, plain glyphs like ○ take 1.
// Pad narrow icons with an extra space so setup names line up in a column.
const isWideIcon = (icon: string) => /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(icon);
const setupTitle = (setup: Setup) => `${setup.icon}${isWideIcon(setup.icon) ? "  " : "   "}${setup.name}`;

const color = (theme: any, paths: readonly ColorPath[], fallback: string) => {
  for (const path of paths) {
    let value = theme;
    for (const key of path) value = value?.[key];
    // V2's live theme.current values are OpenTUI RGBA instances, not strings.
    // Normalize those instances while preserving the host-provided color (and
    // alpha) instead of falling through to the base-surface fallback.
    if (typeof value === "string") return value;
    if (typeof value?.toInts === "function") {
      const [r, g, b, a] = value.toInts();
      const channels = [r, g, b, a].map((channel: number) =>
        Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0"),
      );
      return `#${channels.join("")}`;
    }
  }
  return fallback;
};

export const colors = (theme: any) => ({
  // Use the same flat semantic tokens as OpenCode's native TUI sidebar. The
  // nested paths are retained only for compatibility with older host builds.
  primary: color(theme, [["current", "primary"], ["text", "action", "primary", "base"], ["text", "status", "unread"], ["primary", "default"], ["primary"]], "#60a5fa"),
  surface: color(theme, [["current", "backgroundPanel"], ["backgroundPanel"], ["background", "raised", "base"], ["background", "raised"], ["background", "panel"], ["background", "surface", "offset"], ["background", "element"], ["current", "backgroundElement"], ["background", "base"], ["current", "background"]], "#111111"),
  base: color(theme, [["current", "background"], ["background", "base"], ["background"]], "#111111"),
  raised: color(theme, [["current", "backgroundElement"], ["backgroundElement"], ["background", "raised", "high"], ["background", "raised", "base"], ["background", "element"], ["background", "surface", "raised"]], "#262626"),
  text: color(theme, [["current", "text"], ["text"], ["text", "base"], ["text", "default"]], "#f3f4f6"),
  muted: color(theme, [["current", "textMuted"], ["textMuted"], ["text", "muted"], ["text", "subdued"]], "#9ca3af"),
  selected: color(theme, [["current", "selectedListItemText"], ["selectedListItemText"]], "#f3f4f6"),
  border: color(theme, [["current", "border"], ["border"], ["border", "base"], ["border", "default"]], "#4b5563"),
  borderSubtle: color(theme, [["current", "borderSubtle"], ["borderSubtle"], ["current", "border"], ["border"]], "#4b5563"),
  warning: "#facc15",
  success: "#22c55e",
  error: "#ef4444",
  info: color(theme, [["text", "feedback", "info", "default"], ["info", "default"], ["info"], ["current", "info"]], "#22d3ee"),
});

export default {
  id: "t3code-style-opencode-sidebar",
  setup(ctx: any) {
    const [store, update] = ctx.storage.store("metadata", {
      initial: {
        threads: {},
        activeSetup: "software-factory",
        leftOpen: true,
        pinnedOpen: true,
        needsYouOpen: true,
        runningOpen: false,
        snoozedOpen: true,
        archivedOpen: false,
        projectFilter: "all",
        sidebarScrollTop: 0,
        viewed: {},
      },
    });

    // Guard the update so clean state files are not written on every launch.
    // Rewrite pre-rename archive data once, so the state file stops carrying it.
    if (hasLegacyArchiveState(store)) update((draft: any) => { migrateLegacyArchiveState(draft); });

    const [setupsList, setSetupsList] = createSignal<Setup[]>(readSetups(ctx.location?.directory));
    const reloadSetups = () => {
      const refreshed = readSetups(ctx.location?.directory);
      setSetupsList(refreshed);
      return refreshed;
    };
    const setups = setupsList;
    const [projectCatalogState, setProjectCatalog] = createSignal<ProjectGroup[]>(readProjects());

    // Per-session scope: each chat keeps its own setupId in
    // store.threads[sessionID].setupId. store.activeSetup is only the
    // fallback default for sessions that have never picked one.
    const sessionSetupId = () => {
      const route = ctx.ui.router.current();
      const sessionID = route?.type === "session" ? route.sessionID : undefined;
      return (sessionID ? (store.threads[sessionID] as any)?.setupId : undefined) || store.activeSetup;
    };
    const active = createMemo(() => setups().find((setup) => setup.id === sessionSetupId()) || setups()[0]);
    const isLeftOpen = () => sectionOpen("left", store.leftOpen);
    const leftRailWidth = 38;
    const [scannerFrame, setScannerFrame] = createSignal(0);
    let animationMounted: () => boolean = () => false;
    let scannerIndex = 0;
    const spinnerTimer = setInterval(() => {
      if (!animationMounted()) return;
      scannerIndex = (scannerIndex + 1) % scannerFrameCount;
      setScannerFrame(scannerIndex);
      ctx.renderer.requestRender?.();
    }, 40);
    (spinnerTimer as any).unref?.();

    const compact = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
     const allProjects = () => [noProject, ...projectCatalogState().flatMap((group) => group.projects)];
     const projectResolver = createMemo(() => createProjectResolver(
       projectCatalogState().flatMap((group) => group.projects), homedir(), noProject,
     ));
     let projectCatalogLastRefresh = 0;
     const refreshProjects = (force = false) => {
       if (!force && Date.now() - projectCatalogLastRefresh < 250) return projectCatalogState();
       projectCatalogLastRefresh = Date.now();
        const groups = readProjects();
        const known = groups.flatMap((group) => group.projects);
        const resolver = createProjectResolver(known, homedir(), noProject);
        const other: ProjectEntry[] = [];
        const otherIds = new Set<string>();
       for (const session of allSessions?.() || []) {
         const directory = session.directory || session.location?.directory;
         if (!directory) continue;
          const project = resolver(directory, session.projectID);
         if (project.groupId !== "other" || otherIds.has(project.id)) continue;
         otherIds.add(project.id);
         other.push(project);
      }
      if (other.length > 0) groups.push({ id: "other", name: "OTHER PROJECTS", icon: "◇", root: "", projects: other.sort((a, b) => a.name.localeCompare(b.name)) });
       setProjectCatalog(groups);
       const filter = store.projectFilter || "all";
      if (filter !== "all" && ![noProject, ...groups.flatMap((group) => group.projects)].some((project) => project.id === filter)) {
        update((draft: any) => { draft.projectFilter = "all"; });
      }
      return groups;
     };
      const projectForDirectory = (directory: string | undefined, projectID?: string): ProjectEntry => {
        return projectResolver()(directory, projectID);
      };
    const projectForSession = (session: any): ProjectEntry => projectForDirectory(session.directory || session.location?.directory, session.projectID);
     const projectFilter = () => effectiveProjectFilter(store.projectFilter, allProjects());
    const projectFilterLabel = () => {
      if (projectFilter() === "all") return "All chats";
      return allProjects().find((project) => project.id === projectFilter())?.name || "All chats";
    };
     const projectFilterIcon = () => projectFilter() === "all" ? "▦" : projectFilter() === noProject.id ? "⊘" : "◆";
     const selectProjectFilter = () => {
       refreshProjects(true);
       ctx.ui.dialog.select({
        title: "Filter chats by project",
        placeholder: "All chats or choose a project...",
           options: buildProjectOptions(projectCatalogState(), noProject, { includeAll: true }),
        current: projectFilter(),
      }).then((id: string | undefined) => {
        if (id === undefined) return;
        update((draft: any) => { draft.projectFilter = id; });
      });
     };

      const reportUnavailableProject = () => ctx.ui.toast.show({
       title: "Folder unavailable",
       message: "That project folder no longer exists, so no chat was opened.",
       variant: "warning",
       duration: 3500,
     });

     const openNewChat = () => {
       refreshProjects(true);
       const current = projectFilter();
      if (current === "all") {
        ctx.ui.dialog.select({
          title: "Choose project for new chat",
          placeholder: "Choose a project...",
             options: buildProjectOptions(projectCatalogState(), noProject),
        }).then((id: string | undefined) => {
           if (id === undefined) return;
             const dir = resolveProjectDestination(id, allProjects(), noProject);
           if (!dir) { reportUnavailableProject(); return; }
           ctx.ui.dialog.clear();
          ctx.ui.router.navigate({ type: "home", location: { directory: dir } });
        });
        return;
      }

        const dir = resolveProjectDestination(current, allProjects(), noProject);
       if (!dir) { reportUnavailableProject(); return; }
       ctx.ui.dialog.clear();
      ctx.ui.router.navigate({ type: "home", location: { directory: dir } });
    };

    const sortSessions = (items: any[]) => [...items]
      .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
    const uniqueSessions = (items: any[]) => [...new Map(items.map((session) => [session.id, session])).values()];
     const initialSessions = sortSessions(ctx.data.session.list() || []);
     const refreshState = createRefreshState<any>(initialSessions);
     const [allSessions, setAllSessions] = createSignal<any[]>(initialSessions);
     // Include initial session locations before validating a persisted filter,
     // so a valid outside project is not mistaken for stale metadata.
     refreshProjects(true);
    const sidebarStatus = createSidebarStatus(ctx, allSessions, store.viewed || {}, (id, at) => {
      update((draft: any) => {
        draft.viewed ||= {};
        if (at === undefined) delete draft.viewed[id];
        else draft.viewed[id] = at;
      });
    });
    const markRead = sidebarStatus.markRead;
    const [pressedAction, setPressedAction] = createSignal<string | undefined>();
    const [hoveredAction, setHoveredAction] = createSignal<string | undefined>();
    let pressedActionTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshInFlight: Promise<any[]> | undefined;
    let refreshGeneration = 0;
    let refreshDirty = false;
    let disposed = false;
    let snoozeTimer: ReturnType<typeof setInterval> | undefined;
    const sessionHydrations = new Map<string, Promise<any | undefined>>();
    const sessionPageLimit = 200;
    const syncSessions = async () => {
      if (refreshInFlight) { refreshDirty = true; return refreshInFlight; }
       const generation = ++refreshGeneration;
       const startedAt = refreshState.revision;
      refreshInFlight = (async () => {
        const collected: any[] = [];
        let cursor: string | undefined;
        do {
          const response = await ctx.client.session.list({ limit: sessionPageLimit, order: "desc", ...(cursor ? { cursor } : {}) });
          collected.push(...(response?.data || []));
          const next = response?.cursor?.next || undefined;
          if (!next || next === cursor) break;
          cursor = next;
        } while (cursor);
        if (disposed || generation !== refreshGeneration) return allSessions();
        const sessions = sortSessions(uniqueSessions(commitRefresh(refreshState, collected, startedAt)));
         setAllSessions(sessions);
        refreshProjects();
        return sessions;
      })().catch((error) => {
        // A failed or partial walk is not evidence that known sessions disappeared.
        if (!disposed && generation === refreshGeneration) setTimeout(() => { if (!disposed) void syncSessions(); }, 1000);
        throw error;
      }).finally(() => {
        refreshInFlight = undefined;
        if (refreshDirty && !disposed) { refreshDirty = false; void syncSessions(); }
      });
      return refreshInFlight;
    };
    const flashAction = (key: string) => {
      setPressedAction(key);
      if (pressedActionTimer) clearTimeout(pressedActionTimer);
      pressedActionTimer = setTimeout(() => setPressedAction(undefined), 160);
    };
    const sessionListEventTypes = new Set(["session.created", "session.deleted", "session.moved", "session.renamed", "session.updated"]);
    const eventSessionID = (details: any) => details.data?.sessionID || details.data?.id
      || details.data?.info?.id || details.properties?.sessionID || details.properties?.id
      || details.properties?.info?.id || details.sessionID || details.id;
    const publishSessionEvent = (type: string, id: string, previous: any) => {
      const current = refreshState.records.get(id);
      const currentSessions = allSessions();
      const next = updateSessionList(
        currentSessions,
        id,
        current,
        type === "session.deleted" ? "delete" : "upsert",
      );
      if (next !== currentSessions) setAllSessions(next);

      const locationChanged = previous?.directory !== current?.directory
        || previous?.projectID !== current?.projectID
        || previous?.location?.directory !== current?.location?.directory;
      if (type === "session.created" || type === "session.moved" || locationChanged) refreshProjects();
    };
    const mergeSessionRecords = (items: any[]) => {
      let changed = false;
      for (const session of items) {
        if (!session?.id || refreshState.tombstones.has(session.id)) continue;
        const previous = refreshState.records.get(session.id);
        if (applyRefreshEvent(refreshState, "session.updated", { data: session })) {
          changed ||= previous !== refreshState.records.get(session.id);
        }
      }
      if (!changed) return allSessions();
      const sessions = sortSessions(uniqueSessions(refreshSnapshot(refreshState)));
      setAllSessions(sessions);
      refreshProjects();
      return sessions;
    };
    const hydrateSession = (id: string) => {
      const existing = sessionHydrations.get(id);
      if (existing) return existing;
      const request = (async () => {
        try {
          const session = await ctx.client.session.get({ sessionID: id });
          if (!disposed && session?.id) {
            const previous = refreshState.records.get(id);
            applyRefreshEvent(refreshState, "session.updated", { data: session });
            publishSessionEvent("session.updated", id, previous);
          }
          return session;
        } catch {
          // A targeted read can fail during a reconnect. The reconnect path
          // owns the complete recovery walk, so do not start a second broad
          // scan for every failed event.
          return undefined;
        } finally {
          sessionHydrations.delete(id);
        }
      })();
      sessionHydrations.set(id, request);
      return request;
    };
    const handleSessionListEvent = (rawDetails: any) => {
      const details = rawDetails?.details || rawDetails;
      if (!details || !sessionListEventTypes.has(details.type)) return;
      const id = eventSessionID(details);
      // Check membership before applying the event. A newly-created event is
      // inserted by applyRefreshEvent, so checking afterwards would make an
      // unknown session look known and skip the recovery walk.
      const wasKnown = id ? refreshState.records.has(id) : true;
      const previous = id ? refreshState.records.get(id) : undefined;
      if (id && applyRefreshEvent(refreshState, details.type, details)) publishSessionEvent(details.type, id, previous);
      if (id && !wasKnown) void hydrateSession(id);
    };

    // Prefer typed host subscriptions for session records. They expose the
    // canonical event payload directly; the generic feed remains the fallback
    // for older hosts and is still used for reconnect recovery.
    const sessionStops: Array<() => void> = [];
    const typedSessionEventTypes = new Set(["session.created", "session.deleted", "session.updated"]);
    if (typeof ctx.data.on === "function") {
      for (const type of typedSessionEventTypes) {
        const stop = ctx.data.on(type as any, handleSessionListEvent);
        if (typeof stop === "function") sessionStops.push(stop);
      }
    }
    const stopListening = typeof ctx.data?.listen === "function"
      ? ctx.data.listen(({ details }: any) => {
          if (!details) return;
          if (details.type === "server.connected") {
            void syncSessions();
          } else if (!typedSessionEventTypes.has(details.type)) {
            handleSessionListEvent(details);
          }
        })
      : undefined;
    const isRunning = sidebarStatus.isRunning;
    const matchesProjectFilter = (session: any) => projectFilter() === "all" || projectForSession(session).id === projectFilter();
    const visibleSessions = createMemo(() => allSessions().filter((session) => !session.parentID && matchesProjectFilter(session)));
    const stateFor = (session: any) => {
      // Lifecycle is persisted state; the startup sweep is the only
      // age-based transition.
      return readLifecycle(store.threads, session.id);
    };
    const grouped = createMemo(() => {
      const result = { pinned: [] as any[], needsYou: [] as any[], running: [] as any[], snoozed: [] as any[], archived: [] as any[] };
      for (const session of visibleSessions()) {
        const state = stateFor(session);
        if (state === "pinned" || state === "snoozed" || state === "archived") result[state].push(session);
        else result[sidebarStatus.status(session) === "active" ? "running" : "needsYou"].push(session);
      }
      return result;
    });
    animationMounted = createMemo(() => scannerShouldAnimate(isLeftOpen(), (sectionOpen("running", store.runningOpen) && grouped().running.some((session) => sidebarStatus.status(session) === "active"))
       || (sectionOpen("pinned", store.pinnedOpen) && grouped().pinned.some((session) => sidebarStatus.status(session) === "active"))
       || (sectionOpen("snoozed", store.snoozedOpen) && grouped().snoozed.some((session) => sidebarStatus.status(session) === "active"))
       || (sectionOpen("archived", store.archivedOpen) && grouped().archived.some((session) => sidebarStatus.status(session) === "active"))));
    const relativeTime = (timestamp: number | undefined) => {
      if (!timestamp) return "";
      const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
      if (minutes < 1) return "now";
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h`;
      const days = Math.floor(hours / 24);
      return `${days}d`;
    };
    const currentProjectForSearch = () => {
      const route = ctx.ui.router.current();
      const current = route.type === "session" ? allSessions().find((session) => session.id === route.sessionID) : undefined;
      return current ? projectForSession(current) : projectForDirectory(ctx.location?.directory);
    };
    const searchSessions = () => {
      const [query, setQuery] = createSignal("");
      const [results, setResults] = createSignal<any[]>([]);
       const [selectedIndex, setSelectedIndex] = createSignal(0);
       const [selectedID, setSelectedID] = createSignal<string | undefined>();
       let searchTimer: ReturnType<typeof setTimeout> | undefined;
       let searchRequest = 0;
       let closed = false;
       let scrollBox: any;

      const currentProject = () => currentProjectForSearch();
      const matches = (session: any, value: string) => {
        const terms = value.toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) return true;
        const project = projectForSession(session);
        const haystack = [session.title, session.slug, project.name, session.directory].filter(Boolean).join(" ").toLowerCase();
        return terms.every((term) => haystack.includes(term));
      };
       const rank = (items: any[], value: string) => {
        const project = currentProject();
        const unique = [...new Map(items.filter((session) => !session.parentID).map((session) => [session.id, session])).values()];
        return unique.filter((session) => matches(session, value)).sort((a, b) => {
          const aCurrent = projectForSession(a).id === project.id;
          const bCurrent = projectForSession(b).id === project.id;
          if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
           return (b.time?.updated || 0) - (a.time?.updated || 0);
         });
       };
       const scrollToSelected = (index: number) => {
         if (!scrollBox) return;
         const item = results()[index];
         if (!item) return;
         const currentID = currentProject().id;
         const currentItems = results().filter((session) => projectForSession(session).id === currentID);
         const otherItems = results().filter((session) => projectForSession(session).id !== currentID);
         const isCurrent = projectForSession(item).id === currentID;
         const sectionItems = isCurrent ? currentItems : otherItems;
         const sectionIndex = sectionItems.findIndex((session) => session.id === item.id);
         const itemTop = searchRowOffset(currentItems.length, otherItems.length, isCurrent ? "current" : "other", sectionIndex);
         const itemBottom = itemTop + 1;
         const currentScroll = Number(scrollBox.scrollTop) || 0;
         const viewportHeight = Math.min(12, Math.max(3, results().length + (currentItems.length > 0 ? 1 : 0) + (otherItems.length > 0 ? 2 : 0)));
         if (itemTop < currentScroll) scrollBox.scrollTop = itemTop;
         else if (itemBottom > currentScroll + viewportHeight) scrollBox.scrollTop = itemBottom - viewportHeight;
       };
       const updateResults = (value: string) => {
         const trimmed = value.trim();
         if (searchTimer) clearTimeout(searchTimer);
         const request = searchRequest = nextSearchGeneration(searchRequest);
         setSelectedIndex(0);
         setSelectedID(undefined);
         if (!trimmed) {
           setResults([]);
           return;
         }

        // Show local title/project matches immediately, then merge in the
        // server's broader search results (which can include message text).
          const local = rank(allSessions(), trimmed);
          setResults(local);
          setSelectedID(local[0]?.id);
          searchTimer = setTimeout(async () => {
           try {
             const response = await ctx.client.session.list({ search: trimmed, limit: 100 });
             if (!isCurrentSearch(request, searchRequest, trimmed, query().trim(), closed)) return;
              const serverSessions = response?.data || [];
              // Search is authoritative for the matching records. Merge those
              // records into the sidebar snapshot so a session that was created
              // while the sidebar was mounted also appears in the normal list.
              mergeSessionRecords(serverSessions);
              const next = rank([...allSessions(), ...serverSessions], trimmed);
              const previous = selectedID();
              setResults(next);
              const selection = reconcileSelection(next, previous, selectedIndex());
              setSelectedIndex(selection.index);
              setSelectedID(selection.id);
              setTimeout(() => scrollToSelected(selection.index), 0);
           } catch {
            // Local title/project matches remain available if server search is unavailable.
          }
        }, 120);
      };
       const close = () => {
         closed = true;
          searchRequest = nextSearchGeneration(searchRequest);
         if (searchTimer) clearTimeout(searchTimer);
       };
       const choose = (session: any) => {
         if (!session || !query().trim() || closed) return;
         setSelectedID(session.id);
         openTask(session);
      };
       const chooseSelected = () => {
          if (!query().trim()) return;
          const item = results().find((candidate) => candidate.id === selectedID()) || results()[selectedIndex()];
          if (item && results().some((candidate) => candidate.id === item.id)) choose(item);
        };
      const moveSelection = (delta: number, event: any) => {
        const total = results().length;
        if (total === 0) return;
        event.preventDefault?.();
         setSelectedIndex((index) => {
           const next = (index + delta + total) % total;
            setSelectedID(results()[next]?.id);
            setTimeout(() => scrollToSelected(next), 0);
            return next;
         });
      };
      const dialogColors = colors(ctx.theme);
      const resultRow = (session: any) => {
        const project = projectForSession(session);
        const selected = () => selectedID() === session.id;
        return (
          <box width="100%" minWidth={0} height={1} flexDirection="row" alignItems="center" gap={1} paddingLeft={1} paddingRight={1} backgroundColor={selected() ? dialogColors.raised : undefined} onMouseUp={() => choose(session)}>
            <box width={2} flexShrink={0}>
              <text fg={selected() ? dialogColors.primary : dialogColors.muted}>{selected() ? GLYPHS.pointer : " "}</text>
            </box>
            <text flexGrow={1} flexShrink={1} minWidth={0} height={1} truncate wrapMode="none" fg={selected() ? dialogColors.selected : dialogColors.text}><b>{session.title || "Untitled Session"}</b></text>
            <text flexShrink={0} height={1} truncate wrapMode="none" fg={dialogColors.muted}>{project.id === noProject.id ? `${GLYPHS.indicator.noProject} No project` : `${GLYPHS.indicator.project} ${project.name}`}</text>
            <text flexShrink={0} height={1} fg={dialogColors.muted}>{relativeTime(session.time?.updated)}</text>
          </box>
        );
      };

      ctx.ui.dialog.show(() => {
        const c = dialogColors;
        const current = createMemo(() => results().filter((session) => projectForSession(session).id === currentProject().id));
        const other = createMemo(() => results().filter((session) => projectForSession(session).id !== currentProject().id));
        const resultHeight = () => Math.min(12, Math.max(3, results().length + (current().length > 0 ? 1 : 0) + (other().length > 0 ? 2 : 0)));
        return (
          <box width="100%" minWidth={0} flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
            <box width="100%" minWidth={0} height={2} flexDirection="row" alignItems="center" justifyContent="space-between">
              <text fg={c.text}><b>Search threads</b></text>
              <text fg={c.muted}>esc</text>
            </box>
            <box width="100%" minWidth={0} height={2} flexDirection="row" alignItems="center" gap={1} border={["bottom"]} borderColor={c.border}>
              <text fg={c.muted}>⌕</text>
              <input flexGrow={1} flexShrink={1} minWidth={0} focused={true} placeholder="Search threads..." value={query()} onInput={(value: string) => { setQuery(value); updateResults(value); }} onSubmit={chooseSelected} onKeyDown={(event: any) => {
                 if (event.name === "escape") { event.preventDefault?.(); close(); ctx.ui.dialog.clear(); return; }
                if (event.name === "down") moveSelection(1, event);
                if (event.name === "up") moveSelection(-1, event);
              }} />
            </box>
             <scrollbox ref={(node: any) => { scrollBox = node; setTimeout(() => scrollToSelected(selectedIndex()), 0); }} width="100%" minWidth={0} height={resultHeight()} marginTop={1} scrollY={true} scrollX={false} scrollbarOptions={{ showArrows: false }}>
              <Show when={query().trim().length > 0} fallback={<text fg={c.muted} paddingTop={1} paddingBottom={1}>Type to search all threads. Current project results appear first.</text>}>
                <Show when={current().length > 0}>
                  <box width="100%" minWidth={0} height={1} flexDirection="row" alignItems="center" gap={1}>
                    <text fg={c.primary}><b>THIS PROJECT</b></text>
                    <text fg={c.muted}>· {currentProject().name}</text>
                  </box>
                  <For each={current()}>{(session) => resultRow(session)}</For>
                </Show>
                <Show when={other().length > 0}>
                  <box width="100%" minWidth={0} height={1} marginTop={1} flexDirection="row" alignItems="center" gap={1}>
                    <text fg={c.muted}><b>OTHER PROJECTS</b></text>
                  </box>
                  <For each={other()}>{(session) => resultRow(session)}</For>
                </Show>
                <Show when={results().length === 0}>
                  <box width="100%" minWidth={0} flexDirection="column" alignItems="center" paddingTop={1} paddingBottom={1}>
                    <text fg={c.muted}>No matching threads</text>
                    <text fg={c.muted}>Try searching by title, project, or keyword</text>
                  </box>
                </Show>
              </Show>
            </scrollbox>
            <text fg={c.muted} paddingTop={1}>↑↓ move · Enter open · Esc close</text>
          </box>
        );
      }, close);
      ctx.ui.dialog.set({ size: "medium", centered: true });
    };

    // The v2 `app` slot is mounted above the host's main row. Reserve the
    // same width in that row so the chat and native right sidebar reflow
    // instead of rendering underneath the custom left rail.
    const syncHostLayout = (open = isLeftOpen()) => {
      const root = ctx.renderer.root as any;
      const outer = root?.getChildren?.()[0];
      const mainRow = outer?.getChildren?.()[0];
      if (!mainRow || mainRow === root || mainRow === outer) return;
      const targetPadding = open ? leftRailWidth : 0;
      if (mainRow.paddingLeft !== targetPadding) {
        mainRow.paddingLeft = targetPadding;
        mainRow.requestRender?.();
      }
    };

    const slugify = (text: string) => {
      return text
        .toLowerCase()
        .trim()
        .replace(/[\s\W-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    };

    const getAvailableAgents = (): string[] => {
      const discovered = new Set<string>();
      // Try from ctx location agents
      try {
        const list = ctx.data?.location?.agent?.list?.();
        if (Array.isArray(list)) {
          for (const item of list) {
            const name = item.name || item.id;
            if (name) discovered.add(name);
          }
        }
      } catch {
        // Fall back to reading files
      }

      // Read from ~/.config/opencode/agents/
      const agentsDir = join(homedir(), ".config", "opencode", "agents");
      if (existsSync(agentsDir)) {
        try {
          const files = readdirSync(agentsDir);
          for (const file of files) {
            if (file.endsWith(".md") || file.endsWith(".json")) {
              discovered.add(file.replace(/\.(md|json)$/, ""));
            }
          }
        } catch {
          // Best effort
        }
      }

      // Read from project agents if any
      const projectAgentsDir = join(ctx.location?.directory || process.cwd(), ".opencode", "agents");
      if (existsSync(projectAgentsDir)) {
        try {
          const files = readdirSync(projectAgentsDir);
          for (const file of files) {
            if (file.endsWith(".md") || file.endsWith(".json")) {
              discovered.add(file.replace(/\.(md|json)$/, ""));
            }
          }
        } catch {
          // Best effort
        }
      }

      // Standard defaults if none found
      const fallbackList = [
        "Product Manager",
        "Tech Lead",
        "Backend Guy",
        "Frontend Guy",
        "Design Lead",
        "Designer",
        "Research Lead",
        "Researcher",
        "general",
        "explore",
        "build",
      ];
      for (const item of fallbackList) discovered.add(item);

      return [...discovered].sort((a, b) => a.localeCompare(b));
    };

    const getAvailableSkills = (): string[] => {
      const discovered = new Set<string>();
      try {
        const list = ctx.data?.location?.skill?.list?.();
        if (Array.isArray(list)) {
          for (const item of list) {
            const name = item.id || item.name;
            if (name) discovered.add(name);
          }
        }
      } catch {
        // Fall back
      }

      const skillsDirs = [
        join(homedir(), ".config", "opencode", "skills"),
        join(homedir(), ".agents", "skills"),
        join(ctx.location?.directory || process.cwd(), ".opencode", "skills"),
      ];
      for (const dir of skillsDirs) {
        if (existsSync(dir)) {
          try {
            const entries = readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory() && !entry.name.startsWith(".")) {
                discovered.add(entry.name);
              }
            }
          } catch {
            // Best effort
          }
        }
      }

      return [...discovered].sort((a, b) => a.localeCompare(b));
    };

    const createSetupWizard = async () => {
      // Step 1: Scope (Global or Project-local)
      const projectDir = ctx.location?.directory || process.cwd();
      const scope = await ctx.ui.dialog.select<"global" | "project">({
        title: "New Setup: Step 1/8 · Scope",
        placeholder: "Where should this setup be saved?",
        options: [
          {
            title: "🌐 Global Setup",
            description: "Available in all projects (~/.config/opencode/setups)",
            value: "global",
          },
          {
            title: "📁 Project-local Setup",
            description: `Only in current project (${join(projectDir, ".opencode", "setups")})`,
            value: "project",
          },
        ],
        current: "global",
      });
      if (!scope) return;

      // Step 2: Setup Name
      const name = await ctx.ui.dialog.prompt({
        title: "New Setup: Step 2/8 · Name",
        description: "Enter a human-readable display name for this setup",
        placeholder: "e.g. Frontend Wizard, Mobile Factory, QA Specialist",
      });
      if (!name || !name.trim()) {
        ctx.ui.toast.show({ title: "Setup creation cancelled", message: "A setup name is required.", variant: "warning" });
        return;
      }
      const setupName = name.trim();
      let setupId = slugify(setupName);
      if (!setupId) setupId = `setup-${Date.now()}`;

      // Check if setup already exists
      if (setups().some((s) => s.id === setupId)) {
        const overwrite = await ctx.ui.dialog.confirm({
          title: "Setup already exists",
          message: `A setup with ID "${setupId}" already exists. Do you want to overwrite it?`,
          label: { confirm: "Overwrite", cancel: "Cancel" },
        });
        if (!overwrite) return;
      }

      // Step 3: Icon
      const popularIcons = [
        { icon: "⚡", label: "Lightning" },
        { icon: "🎨", label: "Palette" },
        { icon: "🧪", label: "Lab / Test" },
        { icon: "🛠️", label: "Tools" },
        { icon: "📊", label: "Analytics" },
        { icon: "🔍", label: "Search" },
        { icon: "🤖", label: "Robot" },
        { icon: "🌐", label: "Web / Globe" },
        { icon: "🚀", label: "Rocket" },
        { icon: "⚙️", label: "Gear" },
        { icon: "✦", label: "Sparkle" },
      ];
      let selectedIcon = await ctx.ui.dialog.select<string>({
        title: "New Setup: Step 3/8 · Icon",
        placeholder: "Choose an icon or type custom...",
        options: [
          ...popularIcons.map((item) => ({
            title: `${item.icon}  ${item.label}`,
            value: item.icon,
          })),
          {
            title: "✎  Custom emoji / symbol...",
            description: "Type your own icon character",
            value: "__custom_icon__",
          },
        ],
        current: "⚡",
      });
      if (!selectedIcon) return;
      if (selectedIcon === "__custom_icon__") {
        const custom = await ctx.ui.dialog.prompt({
          title: "New Setup: Custom Icon",
          description: "Enter 1 emoji or character",
          placeholder: "e.g. 🎯",
        });
        selectedIcon = custom?.trim() || "✦";
      }

      // Step 4: Lead Agent
      const availableAgents = getAvailableAgents();
      const leadAgent = await ctx.ui.dialog.select<string>({
        title: "New Setup: Step 4/8 · Lead Agent",
        placeholder: "Choose the primary agent leading this setup...",
        options: availableAgents.map((agent) => ({
          title: agent,
          value: agent,
        })),
        current: availableAgents.includes("Product Manager") ? "Product Manager" : availableAgents[0],
      });
      if (!leadAgent) return;

      // Step 5: Allowed Capability Groups (Tools)
      const toolGroupOptions = [
        {
          id: "all",
          title: "All Capabilities (Full Access)",
          description: "terminal, filesystem, browser, computer",
          groups: ["terminal", "filesystem", "browser", "computer"],
        },
        {
          id: "standard",
          title: "Standard Dev (Recommended)",
          description: "terminal, filesystem, browser",
          groups: ["terminal", "filesystem", "browser"],
        },
        {
          id: "code-only",
          title: "Code & Filesystem Only",
          description: "terminal, filesystem",
          groups: ["terminal", "filesystem"],
        },
        {
          id: "read-only",
          title: "Read / Research Only",
          description: "filesystem (read/grep/glob), browser",
          groups: ["filesystem", "browser"],
        },
        {
          id: "custom",
          title: "Custom Capability Selection...",
          description: "Pick each capability group interactively",
          groups: [],
        },
      ];

      const chosenPreset = await ctx.ui.dialog.select<string>({
        title: "New Setup: Step 5/8 · Capability Groups (Tools)",
        placeholder: "Select allowed capabilities...",
        options: toolGroupOptions.map((opt) => ({
          title: opt.title,
          description: opt.description,
          value: opt.id,
        })),
        current: "standard",
      });
      if (!chosenPreset) return;

      let allowedTools: string[] = [];
      if (chosenPreset === "custom") {
        const groups = [
          { key: "terminal", label: "Terminal / Shell (Execution)" },
          { key: "filesystem", label: "Filesystem (Read, write, edit files)" },
          { key: "browser", label: "Browser (Playwright & Chrome DevTools)" },
          { key: "computer", label: "Computer (Desktop Accessibility / CU)" },
        ];
        const selected = new Set<string>(["terminal", "filesystem", "browser"]);
        for (const grp of groups) {
          const include = await ctx.ui.dialog.confirm({
            title: `Capability: ${grp.label}`,
            message: `Include "${grp.key}" capability in this setup?`,
            label: { confirm: "Include", cancel: "Exclude" },
          });
          if (include === undefined) return;
          if (include) selected.add(grp.key);
          else selected.delete(grp.key);
        }
        allowedTools = [...selected];
      } else {
        const matched = toolGroupOptions.find((opt) => opt.id === chosenPreset);
        allowedTools = matched ? [...matched.groups] : ["terminal", "filesystem", "browser"];
      }

      // Step 6: Allowed Subagents
      const subagentPresets = [
        {
          id: "all",
          title: "All Available Subagents (Recommended)",
          description: availableAgents.filter((a) => a !== leadAgent).join(", "),
          agents: availableAgents.filter((a) => a !== leadAgent),
        },
        {
          id: "software-factory",
          title: "Factory Team",
          description: "Tech Lead, Backend Guy, Frontend Guy, explore",
          agents: ["Tech Lead", "Backend Guy", "Frontend Guy", "explore"].filter((a) => a !== leadAgent),
        },
        {
          id: "minimal",
          title: "Minimal (general & explore only)",
          description: "general, explore",
          agents: ["general", "explore"].filter((a) => a !== leadAgent),
        },
        {
          id: "none",
          title: "No Subagents (Standalone Agent)",
          description: "Lead agent works alone without delegating",
          agents: [],
        },
        {
          id: "custom",
          title: "Custom Subagents Selection...",
          description: "Toggle each subagent individually",
          agents: [],
        },
      ];

      const subagentChoice = await ctx.ui.dialog.select<string>({
        title: "New Setup: Step 6/8 · Allowed Subagents",
        placeholder: "Select subagents allowed for delegation...",
        options: subagentPresets.map((p) => ({
          title: p.title,
          description: p.description,
          value: p.id,
        })),
        current: "all",
      });
      if (!subagentChoice) return;

      let allowedAgents: string[] = [];
      if (subagentChoice === "custom") {
        const candidates = availableAgents.filter((a) => a !== leadAgent);
        const selected = new Set<string>();
        for (const ag of candidates) {
          const inc = await ctx.ui.dialog.confirm({
            title: `Subagent: ${ag}`,
            message: `Allow delegation to "${ag}"?`,
            label: { confirm: "Allow", cancel: "Skip" },
          });
          if (inc === undefined) return;
          if (inc) selected.add(ag);
        }
        allowedAgents = [...selected];
      } else {
        const matched = subagentPresets.find((p) => p.id === subagentChoice);
        allowedAgents = matched ? [...matched.agents] : [];
      }

      // Step 7: Allowed Skills
      const availableSkills = getAvailableSkills();
      const skillPresets = [
        {
          id: "all",
          title: "All Installed Skills (Recommended)",
          description: availableSkills.length > 0 ? availableSkills.join(", ") : "None installed",
          skills: availableSkills,
        },
        {
          id: "browser-computer",
          title: "Browser & Computer Use Skills",
          description: "playwright-cli, computer-use, chrome-devtools",
          skills: ["playwright-cli", "computer-use", "chrome-devtools"].filter((s) => availableSkills.includes(s)),
        },
        {
          id: "none",
          title: "No Skills",
          description: "Do not load extra skills into context",
          skills: [],
        },
        {
          id: "custom",
          title: "Custom Skill Selection...",
          description: "Toggle individual skills",
          skills: [],
        },
      ];

      const skillChoice = await ctx.ui.dialog.select<string>({
        title: "New Setup: Step 7/8 · Allowed Skills",
        placeholder: "Select skills available to this setup...",
        options: skillPresets.map((p) => ({
          title: p.title,
          description: p.description,
          value: p.id,
        })),
        current: "all",
      });
      if (!skillChoice) return;

      let allowedSkills: string[] = [];
      if (skillChoice === "custom") {
        const selected = new Set<string>();
        for (const sk of availableSkills) {
          const inc = await ctx.ui.dialog.confirm({
            title: `Skill: ${sk}`,
            message: `Enable skill "${sk}" for this setup?`,
            label: { confirm: "Enable", cancel: "Skip" },
          });
          if (inc === undefined) return;
          if (inc) selected.add(sk);
        }
        allowedSkills = [...selected];
      } else {
        const matched = skillPresets.find((p) => p.id === skillChoice);
        allowedSkills = matched ? [...matched.skills] : [];
      }

      // Step 8: System Prompt
      const systemPrompt = await ctx.ui.dialog.prompt({
        title: "New Setup: Step 8/8 · System Prompt",
        description: "Custom system instructions injected at turn start (optional)",
        placeholder: "e.g. Focus on high code quality, clean modular architecture, and thorough testing.",
        value: "",
      });
      if (systemPrompt === undefined) return;

      // Step 9: Save & Activate
      const targetDir = scope === "global"
        ? join(homedir(), ".config", "opencode", "setups", setupId)
        : join(projectDir, ".opencode", "setups", setupId);

      const setupConfig = {
        id: setupId,
        name: setupName,
        icon: selectedIcon,
        leadAgent,
        prompt: systemPrompt.trim(),
        agents: allowedAgents,
        skills: allowedSkills,
        tools: allowedTools,
      };

      try {
        mkdirSync(targetDir, { recursive: true });
        writeFileSync(join(targetDir, "setup.json"), JSON.stringify(setupConfig, null, 2), "utf8");

        // Reload setups list immediately
        const refreshed = reloadSetups();

        // Switch active session / global default to newly created setup
        const route = ctx.ui.router.current();
        const currentSessionID = route?.type === "session" ? route.sessionID : undefined;
        if (currentSessionID) {
          const sid = currentSessionID;
          update((draft: any) => {
            const item = draft.threads[sid] || { lifecycle: "running", setupId: draft.activeSetup };
            item.setupId = setupId;
            draft.threads[sid] = item;
          });
        } else {
          update((draft: any) => { draft.activeSetup = setupId; });
        }

        ctx.ui.toast.show({
          title: "Setup created & activated!",
          message: `${selectedIcon} ${setupName} (${scope})`,
          variant: "success",
          duration: 3500,
        });
      } catch (err: any) {
        ctx.ui.toast.show({
          title: "Failed to create setup",
          message: err?.message || "An error occurred writing setup.json",
          variant: "error",
          duration: 4000,
        });
      }
    };

    const promptDelete = async (setup: Setup) => {
      if (setup.isBuiltin) {
        ctx.ui.toast.show({
          title: "Cannot delete built-in",
          message: `“${setup.name}” is a built-in system setup and cannot be deleted.`,
          variant: "warning",
          duration: 3000,
        });
        return;
      }

      const confirmed = await ctx.ui.dialog.confirm({
        title: "Delete setup?",
        message: `Permanently delete “${setup.name}”? This will remove its configuration on disk and cannot be undone.`,
        label: { confirm: "Delete Setup", cancel: "Keep" },
      });
      if (!confirmed) return;

      try {
        if (setup.dirPath && existsSync(setup.dirPath)) {
          rmSync(setup.dirPath, { recursive: true, force: true });
        }
        const route = ctx.ui.router.current();
        const currentSessionID = route?.type === "session" ? route.sessionID : undefined;
        const fallbackId = "software-factory";
        update((draft: any) => {
          if (currentSessionID) {
            const thread = draft.threads?.[currentSessionID];
            if (thread?.setupId === setup.id) thread.setupId = fallbackId;
          }
          if (draft.activeSetup === setup.id) draft.activeSetup = fallbackId;
          for (const sid of Object.keys(draft.threads || {})) {
            if (draft.threads[sid]?.setupId === setup.id) draft.threads[sid].setupId = fallbackId;
          }
        });

        reloadSetups();
        ctx.ui.toast.show({
          title: "Setup deleted",
          message: `Removed “${setup.name}”. Running sessions switched to Software Factory.`,
          variant: "success",
          duration: 3000,
        });
        switchSetup();
      } catch (err: any) {
        ctx.ui.toast.show({
          title: "Delete failed",
          message: err?.message || "Could not delete setup directory.",
          variant: "error",
          duration: 3500,
        });
      }
    };

    const normalizeIcon = (icon: string) => icon.replace(/\uFE0F/g, "");

    const switchSetup = () => {
      reloadSetups();
      const c = colors(ctx.theme);
      const route = ctx.ui.router.current();
      const currentSessionID = route?.type === "session" ? route.sessionID : undefined;
      const currentId = (currentSessionID ? (store.threads[currentSessionID] as any)?.setupId : undefined) || store.activeSetup;

      const [query, setQuery] = createSignal("");
      const all = setups();
      const activeSetupObj = all.find((s) => s.id === currentId) || all[0];
      const initialIndex = all.findIndex((setup) => setup.id === currentId);
      const [selectedIndex, setSelectedIndex] = createSignal(initialIndex >= 0 ? initialIndex : 0);
      let scrollBox: any;

      const filteredSetups = createMemo(() => {
        const q = query().toLowerCase().trim();
        if (!q) return setups();
        return setups().filter((setup) => {
          const haystack = `${setup.name} ${setup.leadAgent} ${setup.scope}`.toLowerCase();
          return haystack.includes(q);
        });
      });

      const totalItems = () => filteredSetups().length + 1; // setups + "+ Create New Setup..."

      const listHeight = () => {
        const count = filteredSetups().length;
        if (count === 0) return 2;
        return Math.min(8, count * 2);
      };

      const scrollToSelected = (index: number) => {
        if (!scrollBox) return;
        const count = filteredSetups().length;
        if (index >= count) return;
        const itemTop = index * 2;
        const itemBottom = itemTop + 2;
        const currentScroll = Number(scrollBox.scrollTop) || 0;
        const viewportHeight = listHeight();
        if (itemTop < currentScroll) {
          scrollBox.scrollTop = itemTop;
        } else if (itemBottom > currentScroll + viewportHeight) {
          scrollBox.scrollTop = itemBottom - viewportHeight;
        }
      };

      const moveSelection = (delta: number, event?: any) => {
        event?.preventDefault?.();
        const count = totalItems();
        if (count === 0) return;
        setSelectedIndex((prev) => {
          const next = (prev + delta + count) % count;
          scrollToSelected(next);
          return next;
        });
      };

      const updateQuery = (value: string) => {
        setQuery(value);
        setSelectedIndex(0);
        if (scrollBox) scrollBox.scrollTop = 0;
      };

      const applySetup = (setup: Setup) => {
        ctx.ui.dialog.clear();
        if (currentSessionID) {
          const sid = currentSessionID;
          update((draft: any) => {
            const item = draft.threads[sid] || { lifecycle: "running", setupId: draft.activeSetup };
            item.setupId = setup.id;
            draft.threads[sid] = item;
          });
        } else {
          update((draft: any) => { draft.activeSetup = setup.id; });
        }
        ctx.ui.toast.show({ title: "Setup switched", message: setup.name, variant: "success", duration: 1800 });
      };

      const chooseCurrent = () => {
        const items = filteredSetups();
        const index = selectedIndex();
        if (index === items.length) {
          ctx.ui.dialog.clear();
          void createSetupWizard();
          return;
        }
        const chosen = items[index];
        if (chosen) {
          applySetup(chosen);
        }
      };

      const formatMeta = (setup: Setup) => {
        const parts = [`Lead: ${setup.leadAgent}`];
        if (setup.agents && setup.agents.length > 0) {
          parts.push(`${setup.agents.length} ${setup.agents.length === 1 ? "agent" : "agents"}`);
        }
        if (setup.skills && setup.skills.length > 0) {
          parts.push(`${setup.skills.length} ${setup.skills.length === 1 ? "skill" : "skills"}`);
        }
        return parts.join(" · ");
      };

      ctx.ui.dialog.show(() => {
        const isNewFocused = () => selectedIndex() === filteredSetups().length;

        return (
          <box width="100%" minWidth={0} flexDirection="column" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
            {/* Header */}
            <box width="100%" minWidth={0} flexDirection="column" paddingBottom={1}>
              <box width="100%" minWidth={0} height={1} flexDirection="row" alignItems="center" justifyContent="space-between">
                <box flexDirection="row" alignItems="center" gap={1}>
                  <text fg={c.primary}><b>⚙</b></text>
                  <text fg={c.text}><b>Switch Setup</b></text>
                </box>
                <text fg={c.muted}>esc</text>
              </box>
              <text fg={c.muted} height={1} truncate wrapMode="none">Running in this thread: {activeSetupObj?.icon} {activeSetupObj?.name}</text>
            </box>

            {/* Filter Input */}
            <box width="100%" minWidth={0} height={2} flexDirection="row" alignItems="center" gap={1} border={["bottom"]} borderColor={c.border}>
              <text fg={c.muted}>⌕</text>
              <input
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
                focused={true}
                placeholder="Filter setups..."
                value={query()}
                onInput={(value: string) => updateQuery(value)}
                onSubmit={chooseCurrent}
                onKeyDown={(event: any) => {
                  if (event.name === "escape") {
                    event.preventDefault?.();
                    ctx.ui.dialog.clear();
                    return;
                  }
                  if (event.name === "down") {
                    moveSelection(1, event);
                    return;
                  }
                  if (event.name === "up") {
                    moveSelection(-1, event);
                    return;
                  }
                  if (event.name === "tab") {
                    moveSelection(event.shift ? -1 : 1, event);
                    return;
                  }
                  if (
                    (event.ctrl && event.name === "d") ||
                    event.name === "delete" ||
                    (event.name === "backspace" && query() === "")
                  ) {
                    const items = filteredSetups();
                    const index = selectedIndex();
                    if (index < items.length) {
                      const selectedSetup = items[index];
                      event.preventDefault?.();
                      ctx.ui.dialog.clear();
                      void promptDelete(selectedSetup);
                      return;
                    }
                  }
                  if (!event.ctrl && !event.meta && (event.name === "n" || event.sequence === "n") && query().trim() === "") {
                    event.preventDefault?.();
                    ctx.ui.dialog.clear();
                    void createSetupWizard();
                    return;
                  }
                }}
              />
            </box>

            {/* Setups List */}
            <scrollbox
              ref={(node: any) => {
                scrollBox = node;
                setTimeout(() => scrollToSelected(selectedIndex()), 0);
              }}
              width="100%"
              minWidth={0}
              height={listHeight()}
              marginTop={1}
              scrollY={true}
              scrollX={false}
              scrollbarOptions={{ showArrows: false }}
            >
              <Show when={filteredSetups().length > 0} fallback={<text fg={c.muted} paddingTop={1} paddingBottom={1}>No matching setups.</text>}>
                <For each={filteredSetups()}>
                  {(setup, index) => {
                    const isFocused = () => selectedIndex() === index();
                    const isCurrent = () => setup.id === currentId;
                    return (
                      <box
                        width="100%"
                        minWidth={0}
                        flexDirection="column"
                        paddingLeft={1}
                        paddingRight={1}
                        paddingTop={0}
                        paddingBottom={0}
                        backgroundColor={isFocused() ? c.raised : undefined}
                        onMouseUp={() => applySetup(setup)}
                      >
                        {/* Line 1 */}
                        <box width="100%" minWidth={0} height={1} flexDirection="row" alignItems="center">
                          <box width={2} flexShrink={0}>
                            <text fg={isFocused() ? c.primary : isCurrent() ? c.success : c.muted}>
                              {isFocused() ? "❯ " : isCurrent() ? "● " : "  "}
                            </text>
                          </box>
                          <box width={3} flexShrink={0}>
                            <text fg={isFocused() ? c.primary : c.text}><b>{normalizeIcon(setup.icon)}</b></text>
                          </box>
                          <text flexGrow={1} flexShrink={1} minWidth={0} truncate wrapMode="none" fg={c.text}>
                            <b>{setup.name}</b>
                          </text>
                          {/* Scope column (8 cols, fixed width, right aligned) */}
                          <box width={8} flexShrink={0} justifyContent="flex-end">
                            <text wrapMode="none" fg={c.muted}>
                              {setup.isBuiltin ? "system" : setup.scope === "global" ? "global" : "project"}
                            </text>
                          </box>
                          {/* Status / Action column (14 cols, fixed width, right aligned) */}
                          <box width={14} flexShrink={0} justifyContent="flex-end">
                            <Show
                              when={isFocused() && !setup.isBuiltin}
                              fallback={
                                <Show when={isCurrent()} fallback={<text> </text>}>
                                  <text wrapMode="none" fg={c.success}>✓ current</text>
                                </Show>
                              }
                            >
                              <box
                                flexDirection="row"
                                alignItems="center"
                                justifyContent="flex-end"
                                onMouseUp={(e: any) => {
                                  e.stopPropagation?.();
                                  ctx.ui.dialog.clear();
                                  void promptDelete(setup);
                                }}
                              >
                                <text wrapMode="none" fg={c.error}><b>[× del]</b></text>
                                <text wrapMode="none" fg={c.muted}> ⌫</text>
                              </box>
                            </Show>
                          </box>
                        </box>

                        {/* Line 2 */}
                        <box width="100%" minWidth={0} height={1} flexDirection="row" alignItems="center" paddingLeft={5}>
                          <text flexGrow={1} flexShrink={1} minWidth={0} truncate wrapMode="none" fg={c.muted}>
                            {formatMeta(setup)}
                          </text>
                        </box>
                      </box>
                    );
                  }}
                </For>
              </Show>
            </scrollbox>

            {/* Divider & "+ Create New Setup..." */}
            <box
              width="100%"
              minWidth={0}
              flexDirection="column"
              marginTop={1}
              border={["top"]}
              borderColor={c.border}
            >
              <box
                width="100%"
                minWidth={0}
                flexDirection="column"
                paddingLeft={1}
                paddingRight={1}
                paddingTop={0}
                paddingBottom={0}
                backgroundColor={isNewFocused() ? c.raised : undefined}
                onMouseUp={() => {
                  ctx.ui.dialog.clear();
                  void createSetupWizard();
                }}
              >
                {/* Line 1 */}
                <box width="100%" minWidth={0} height={1} flexDirection="row" alignItems="center">
                  <box width={2} flexShrink={0}>
                    <text fg={isNewFocused() ? c.primary : c.muted}>
                      {isNewFocused() ? "❯ " : "  "}
                    </text>
                  </box>
                  <box width={3} flexShrink={0}>
                    <text fg={isNewFocused() ? c.primary : c.text}><b>+</b></text>
                  </box>
                  <text flexGrow={1} flexShrink={1} minWidth={0} truncate wrapMode="none" fg={c.text}>
                    <b>Create New Setup...</b>
                  </text>
                  <box width={14} flexShrink={0} justifyContent="flex-end">
                    <text wrapMode="none" fg={isNewFocused() ? c.primary : c.muted}>
                      [n] ↵
                    </text>
                  </box>
                </box>

                {/* Line 2 */}
                <box width="100%" minWidth={0} height={1} flexDirection="row" alignItems="center" paddingLeft={5}>
                  <text flexGrow={1} flexShrink={1} minWidth={0} truncate wrapMode="none" fg={c.muted}>
                    Configure lead agent, subagents, skills & instructions
                  </text>
                </box>
              </box>
            </box>

            {/* Bottom footer hotkey legend */}
            <box width="100%" minWidth={0} height={1} marginTop={1} paddingLeft={1} paddingRight={1} flexDirection="row" alignItems="center" justifyContent="space-between">
              <text fg={c.muted}>↑↓ move · ↵ switch · ⌫ delete · [n] new</text>
              <text fg={c.muted}>esc close</text>
            </box>
          </box>
        );
      });

      ctx.ui.dialog.set({ size: "medium", centered: true });
    };

    const toggleLeft = () => {
      const next = !isLeftOpen();
      update((draft: any) => { draft.leftOpen = next; });
      syncHostLayout(next);
    };

    const toggle = (key: "pinnedOpen" | "needsYouOpen" | "runningOpen" | "snoozedOpen" | "archivedOpen") => {
      update((draft: any) => {
        draft[key] = (key === "pinnedOpen" || key === "needsYouOpen" || key === "runningOpen") ? draft[key] === false : !draft[key];
      });
    };

    const lifecycle = (id: string, state: Lifecycle) => {
      if (state === "archived" && sidebarStatus.isRunning({ id } as any)) {
        ctx.ui.toast.show({ title: "Still running", message: "Archive it once it finishes.", variant: "info", duration: 2200 });
        return;
      }
      update((draft: any) => {
        const item = updateThreadLifecycle(draft.threads, id, state, draft.activeSetup);
        if (state !== "snoozed") delete item.snoozeUntil;
      });
    };
    const wokenSessionIds = new Set<string>();
    const [wokenVersion, setWokenVersion] = createSignal(0);
    createEffect(() => {
      const sessions = uniqueSessions([...allSessions(), ...(ctx.data.session.list() || [])]);
      const revive = sessions.filter((session) => !session.parentID
        && shouldReviveArchived(readLifecycle(store.threads, session.id), isRunning(session)))
        .map((session) => session.id);
      const wake = sessions.filter((session) => !session.parentID
        && shouldWakeSnoozed(readLifecycle(store.threads, session.id), isRunning(session)))
        .map((session) => session.id);
      if (!revive.length && !wake.length) return;
      untrack(() => update((draft: any) => {
        for (const id of revive) {
          if (!shouldReviveArchived(readLifecycle(draft.threads, id), true)) continue;
          const item = updateThreadLifecycle(draft.threads, id, "running", draft.activeSetup);
          delete item.snoozeUntil;
          delete item.archivedAt;
        }
        for (const id of wake) {
          if (!shouldWakeSnoozed(readLifecycle(draft.threads, id), true)) continue;
          const item = updateThreadLifecycle(draft.threads, id, "running", draft.activeSetup);
          delete item.snoozeUntil;
        }
      }));
    });
    createEffect(() => {
      const all = uniqueSessions([...allSessions(), ...(ctx.data.session.list() || [])]);
      for (const session of all) {
        const lifecycle = readLifecycle(store.threads, session.id);
        if (wokenSessionIds.has(session.id) && (isRunning(session) || lifecycle !== "running")) {
          wokenSessionIds.delete(session.id);
          setWokenVersion((version) => version + 1);
        }
      }
    });
    const wakeExpiredSnoozes = () => {
      const expired = expiredSnoozes(store.threads, Date.now());
      if (!expired.length) return;
      update((draft: any) => {
        for (const id of expired) {
          const item = draft.threads?.[id];
          if (item?.lifecycle === "snoozed" && item.snoozeUntil <= Date.now()) {
            updateThreadLifecycle(draft.threads, id, "running", draft.activeSetup);
            delete item.snoozeUntil;
            wokenSessionIds.add(id);
            setWokenVersion((version) => version + 1);
          }
        }
      });
    };
    wakeExpiredSnoozes();
    snoozeTimer = setInterval(wakeExpiredSnoozes, 60_000);
    const chooseSnooze = (session: any) => {
      const options = [
        { title: "After 1 hour", value: "1-hour" }, { title: "After 3 hours", value: "3-hours" },
        { title: "Tomorrow", value: "tomorrow" }, { title: "Weekends", value: "weekends" },
        { title: "Next week", value: "next-week" }, { title: "Indefinitely", value: "indefinitely" },
      ];
      void ctx.ui.dialog.select({ title: "Snooze chat", placeholder: "Choose when to wake this chat...", options })
        .then((id: SnoozeOption | undefined) => {
          if (!id) return;
          update((draft: any) => {
            const item = updateThreadLifecycle(draft.threads, session.id, "snoozed", draft.activeSetup);
            const wakeAt = snoozeUntil(Date.now(), id);
            if (wakeAt === undefined) delete item.snoozeUntil;
            else item.snoozeUntil = wakeAt;
          });
        });
    };
    const openTask = (session: any, requestedLifecycle?: Lifecycle) => {
      if (!session) return false;
      const target = session;
      return openTaskThroughCommonPath({ target, requestedLifecycle }, {
        rememberScroll: (beforeNavigation) => rememberSidebarScroll?.(beforeNavigation),
        persistLifecycle: (id, state) => lifecycle(id, state as Lifecycle),
        markRead,
        isVisibleInFilter: matchesProjectFilter,
        showPersistenceError: (error) => ctx.ui.toast.show({
          title: "Could not reopen session",
          message: error instanceof Error ? error.message : "Please try again.",
          variant: "error",
          duration: 3000,
        }),
        showAllChats: () => update((draft: any) => { draft.projectFilter = "all"; }),
        clearDialog: () => ctx.ui.dialog.clear(),
        navigate: (id) => ctx.ui.router.navigate({ type: "session", sessionID: id }),
      });
    };

    const autoArchiveStaleRunning = (sessions: any[]) => {
      const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
      const stale = excludeWokenSessions(sessions, wokenSessionIds).filter((session) => {
        if (session.parentID) return false;
        const saved = readLifecycle(store.threads, session.id);
        const lastActivity = session.time?.updated || session.time?.created || 0;
        return isAutoArchiveEligible(saved) && !isRunning(session) && lastActivity > 0 && lastActivity <= cutoff;
      });
      if (stale.length === 0) return;

      const archivedAt = new Date().toISOString();
      update((draft: any) => {
        for (const session of stale) {
          // Re-check inside the write so an explicit pin/snooze/archive action
          // that happened during the startup fetch always wins.
          if (wokenSessionIds.has(session.id) || isRunning(session) || !isAutoArchiveEligible(readLifecycle(draft.threads, session.id))) continue;
          const updated = updateThreadLifecycle(draft.threads, session.id, "archived", draft.activeSetup);
          updated.archivedAt = archivedAt;
        }
      });
    };
    void syncSessions().then((sessions) => {
      if (!disposed) autoArchiveStaleRunning(sessions);
    }).catch(() => undefined);

    const deleteSession = async (session: any) => {
      const title = session.title || "Untitled Session";
      const confirmed = await ctx.ui.dialog.confirm({
        title: "Delete session?",
        message: `Delete “${title}”? This cannot be undone.`,
        label: { confirm: "Delete", cancel: "Keep" },
      });
      if (!confirmed) return;

      try {
        const route = ctx.ui.router.current();
        if (route.type === "session" && route.sessionID === session.id) {
          ctx.ui.router.navigate({ type: "home" });
        }
        await ctx.client.session.remove({ sessionID: session.id });
        ctx.data.session.invalidate();
        sidebarStatus.forget(session.id);
        applyRefreshEvent(refreshState, "session.deleted", { data: { sessionID: session.id } });
        publishSessionEvent("session.deleted", session.id, session);
        update((draft: any) => { delete draft.threads[session.id]; });
        ctx.ui.toast.show({ title: "Session deleted", message: title, variant: "success", duration: 1800 });
      } catch (error: any) {
        ctx.ui.toast.show({ title: "Could not delete session", message: error?.message || "Please try again.", variant: "error", duration: 3000 });
      }
    };

    // Both controls stay reachable even when either sidebar is closed.
    ctx.ui.slot({
      append: "session.composer.top",
      render() {
        const c = colors(ctx.theme);
        return (
          <box flexDirection="row" justifyContent="space-between" width="100%" paddingBottom={1}>
            <text fg={c.primary} onMouseUp={toggleLeft}><b>‹ Left</b></text>
            <text fg={c.muted} onMouseUp={() => ctx.keymap.dispatch("session.sidebar.toggle")}><b>› Right</b></text>
          </box>
        );
      },
    });

    // OpenCode exposes one sidebar slot and it is the native right context panel.
    // Keep it native; only add a small toggle affordance to its top.
    ctx.ui.slot({
      prepend: "sidebar.content",
      render() {
        const c = colors(ctx.theme);
        return (
          <box flexDirection="row" justifyContent="space-between" width="100%" paddingBottom={1} border={["bottom"]} borderColor={c.border}>
            <text fg={c.muted}>CONTEXT</text>
            <text fg={c.primary} onMouseUp={() => ctx.keymap.dispatch("session.sidebar.toggle")}><b>›</b></text>
          </box>
        );
      },
    });

    // The priority stream is mounted at app level so it is a real left overlay,
    // separate from OpenCode's native right sidebar.
    let sidebarScroll: any;
    let sidebarScrollTop = Number(store.sidebarScrollTop) || 0;
    let sidebarScrollRestoreTimer: ReturnType<typeof setTimeout> | undefined;
    const rememberSidebarScroll = (persist = false) => {
      if (!sidebarScroll) return;
      const value = Number(sidebarScroll.scrollTop);
      if (!Number.isFinite(value)) return;
      sidebarScrollTop = Math.max(0, value);
      if (persist) update((draft: any) => { draft.sidebarScrollTop = sidebarScrollTop; });
    };
    const restoreSidebarScroll = (node: any) => {
      if (!node) return;
      if (sidebarScrollRestoreTimer) clearTimeout(sidebarScrollRestoreTimer);
      sidebarScrollRestoreTimer = setTimeout(() => {
        if (sidebarScroll === node) {
          node.scrollTop = sidebarScrollTop;
        }
      }, 0);
    };
    ctx.ui.slot({
      append: "app",
      render() {
        const c = colors(ctx.theme);
        const current = () => {
          const route = ctx.ui.router.current();
          return route.type === "session" ? route.sessionID : undefined;
        };
          const selectedRow = (session: any) => session.id === current();
          const rowShell = (session: any, content: any) => (
            <box width="100%" flexShrink={1} minWidth={0} onMouseUp={() => openTask(session)}>
              <box width="100%" flexShrink={1} minWidth={0} paddingLeft={1} paddingRight={1} backgroundColor={selectedRow(session) ? c.raised : undefined}>
                {content}
              </box>
            </box>
          );

         const statusRail = (session: any) => {
            const status = () => sidebarStatus.status(session);
            const displayStatus = () => {
              wokenVersion();
              return wokenSessionIds.has(session.id) && (status() === "unread" || status() === "read") ? "woken" : status();
            };
            const staticGlyph = () => (
              <box width={scannerWidth} height={1} flexDirection="row" gap={0} justifyContent="center">
                <For each={scannerCells}>{() => <text width={1} height={1} wrapMode="none" fg={statusColors[displayStatus()]}>⬝</text>}</For>
             </box>
           );
           return (
             <box flexGrow={1} flexShrink={1} minWidth={scannerWidth} height={1} alignItems="center" justifyContent="center" overflow="hidden">
               <Show when={status() === "active"} fallback={staticGlyph()}>
                 <box width={scannerWidth} height={1} flexDirection="row" gap={0} justifyContent="center">
                    <For each={scannerFrameAt(scannerFrame())}>{(cell) => <text width={1} height={1} wrapMode="none" fg={cell.color}>{cell.glyph}</text>}</For>
                 </box>
               </Show>
             </box>
           );
         };

          const action = (session: any, name: string, run: () => void) => {
            const key = `${session.id}:${name}`;
            const stop = (event: any) => event.stopPropagation?.();
            const pressed = () => pressedAction() === key;
            const hovered = () => hoveredAction() === key;
            const active = () => pressed() || hovered();
            const hoverColor = name === "delete" ? c.error : name === "archive" ? c.success : name === "snooze" || name === "wake" ? c.info : c.primary;
            const press = (event: any) => { stop(event); rememberSidebarScroll(true); flashAction(key); };
            return (
              <box flexGrow={0} flexShrink={0} height={1} alignItems="center" justifyContent="center" onMouseOver={(event: any) => { stop(event); setHoveredAction(key); }} onMouseOut={(event: any) => { stop(event); if (hoveredAction() === key) setHoveredAction(undefined); }} onMouseDown={press} onMouseUp={(event: any) => { press(event); run(); }}>
                <text wrapMode="none" fg={active() ? hoverColor : c.muted}>{name}</text>
              </box>
            );
          };
         const compactAction: Record<string, string> = { pinned: "unpin", snoozed: "wake", archived: "restore" };
          const ExpandedActiveRow = (session: any) => {
            const project = projectForSession(session);
             const titleColor = () => selectedRow(session) ? c.selected : c.text;
             return rowShell(session, <box flexDirection="column" gap={1}>
             <box width="100%" minWidth={0} flexDirection="row" alignItems="center" gap={1}>
               <text height={1} flexGrow={0} flexShrink={1} minWidth={0} truncate wrapMode="none" fg={c.muted}>{project.name}</text>
               {statusRail(session)}
               <text height={1} flexShrink={0} fg={c.muted}>{relativeTime(session.time?.updated)}</text>
             </box>
               <text width="100%" minWidth={0} height={1} truncate wrapMode="none" fg={titleColor()}><b>{session.title || "Untitled Session"}</b></text>
              <box width="100%" minWidth={0} height={1} flexDirection="row" alignItems="center" gap={1}>
               {action(session, "pin", () => lifecycle(session.id, "pinned"))}
               <text fg={c.muted}>·</text>
                {action(session, "snooze", () => chooseSnooze(session))}
               <text fg={c.muted}>·</text>
               {action(session, "archive", () => lifecycle(session.id, "archived"))}
               <text fg={c.muted}>·</text>
               {action(session, "delete", () => { void deleteSession(session); })}
             </box>
           </box>);
         };
          const CompactTaskRow = (session: any, state: string) => {
            const project = projectForSession(session);
            const marker = state === "pinned" ? "● " : state === "archived" ? "✓ " : "";
            const transition = compactAction[state];
             const titleColor = () => selectedRow(session) ? c.selected : c.text;
              return rowShell(session, <box flexDirection="column">
             <box width="100%" minWidth={0} height={1} flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
                <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" fg={titleColor()}><b>{marker}{compact(session.title || "Untitled Session", 21)}</b></text>
               {action(session, transition, () => openTask(session, "running"))}
             </box>
             <box width="100%" minWidth={0} height={1} flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
                <text flexGrow={0} flexShrink={1} minWidth={0} truncate wrapMode="none" fg={c.muted}>{compact(project.name, 16)}</text>
               {statusRail(session)}
                <text flexShrink={0} wrapMode="none" fg={c.muted}>{relativeTime(session.time?.updated)}</text>
               {action(session, "delete", () => { void deleteSession(session); })}
             </box>
           </box>);
         };
         const row = (session: any, state: string) => state === "running" || state === "needsYou" ? ExpandedActiveRow(session) : CompactTaskRow(session, state);

        const chatDivider = () => (
          <box width="100%" flexShrink={1} minWidth={0} height={1} marginTop={0} marginBottom={0} border={["bottom"]} borderColor={c.border} />
        );



        return (
          <Show when={isLeftOpen()}>
             <box position="absolute" left={-leftRailWidth} top={0} width={leftRailWidth} height="100%" zIndex={20} flexDirection="column" backgroundColor={c.surface} border={["right"]} borderColor={c.border} paddingLeft={1} paddingRight={1}>
              <box width="100%" minWidth={0} height={3} flexDirection="row" alignItems="center" gap={1} marginTop={1}>
                <box flexGrow={1} flexShrink={1} minWidth={0} height={3} flexDirection="row" alignItems="center" gap={1} paddingLeft={2} paddingRight={2} border={true} borderStyle="rounded" borderColor={c.border} onMouseUp={searchSessions}>
                  <text fg={c.muted}>⌕</text>
                  <text fg={c.muted}>Search threads</text>
                </box>
                <box width={5} height={3} flexShrink={0} alignItems="center" justifyContent="center" border={true} borderStyle="rounded" borderColor={c.border} onMouseUp={openNewChat}>
                  <text fg={c.primary}><b>+</b></text>
                </box>
              </box>
              <box width="100%" minWidth={0} height={1} marginTop={1} flexDirection="row" alignItems="center" gap={1} paddingLeft={1} paddingRight={1} onMouseUp={selectProjectFilter}>
                <text fg={c.muted}>{projectFilterIcon()}</text>
                <text fg={projectFilter() === "all" ? c.text : c.primary}><b>{compact(projectFilterLabel(), 20)}</b></text>
                <box flexGrow={1} flexShrink={1} minWidth={2} height={1} border={["top"]} borderColor={c.border} />
                <text fg={c.muted}>⌄</text>
              </box>
              <scrollbox ref={(node: any) => {
                if (sidebarScroll === node) return;
                sidebarScroll = node;
                restoreSidebarScroll(node);
              }} onMouseScroll={() => { setTimeout(() => rememberSidebarScroll(), 0); }} onKeyDown={() => { setTimeout(() => rememberSidebarScroll(), 0); }} width="100%" minWidth={0} flexDirection="column" flexGrow={1} scrollY={true} scrollX={false} scrollbarOptions={{ showArrows: false, visible: false }}>
                <box width="100%" height={1} />
                <Show when={grouped().pinned.length > 0}>
                  <box width="100%" minWidth={0} flexDirection="row" gap={1} paddingTop={1} paddingBottom={1} onMouseUp={() => toggle("pinnedOpen")}>
                    <text fg={c.muted}><b>{sectionOpen("pinned", store.pinnedOpen) ? "▾" : "▸"} Pinned</b></text>
                    <text fg={c.muted}>({grouped().pinned.length})</text>
                  </box>
                  <Show when={sectionOpen("pinned", store.pinnedOpen)}>
                    <For each={grouped().pinned}>{(session, index) => <>{row(session, "pinned")}{index() < grouped().pinned.length - 1 ? chatDivider() : null}</>}</For>
                    <Show when={grouped().needsYou.length + grouped().running.length > 0}>
                      <box width="100%" height={1} marginTop={1} marginBottom={1} border={["bottom"]} borderColor={c.border} />
                    </Show>
                  </Show>
                </Show>
                <Show when={grouped().needsYou.length > 0}>
                  <box width="100%" minWidth={0} flexDirection="row" gap={1} paddingTop={1} paddingBottom={1} onMouseUp={() => toggle("needsYouOpen")}>
                    <text fg={c.muted}><b>{sectionOpen("needsYou", store.needsYouOpen) ? "▾" : "▸"} Needs You</b></text>
                    <text fg={c.muted}>({grouped().needsYou.length})</text>
                  </box>
                  <Show when={sectionOpen("needsYou", store.needsYouOpen)}>
                    <For each={grouped().needsYou}>{(session, index) => <>{row(session, "needsYou")}{index() < grouped().needsYou.length - 1 ? chatDivider() : null}</>}</For>
                  </Show>
                  <Show when={grouped().running.length > 0}><box width="100%" height={1} marginTop={1} marginBottom={1} border={["bottom"]} borderColor={c.border} /></Show>
                </Show>
                <Show when={grouped().running.length > 0} fallback={
                  <Show when={grouped().needsYou.length === 0 && grouped().pinned.length === 0}>
                    <box width="100%" minWidth={0} flexDirection="column" alignItems="center" paddingTop={2} paddingBottom={2} gap={0}>
                      <text fg={c.muted}>◌ No running threads</text>
                      <text fg={c.muted}>Press <b>+</b> to start a new chat</text>
                    </box>
                  </Show>
                }>
                  <box width="100%" minWidth={0} flexDirection="row" gap={1} paddingTop={1} paddingBottom={1} onMouseUp={() => toggle("runningOpen")}>
                    <text fg={c.muted}><b>{sectionOpen("running", store.runningOpen) ? "▾" : "▸"} Running</b></text>
                    <text fg={c.muted}>({grouped().running.length})</text>
                  </box>
                  <Show when={sectionOpen("running", store.runningOpen)}>
                    <For each={grouped().running}>{(session, index) => <>{row(session, "running")}{index() < grouped().running.length - 1 ? chatDivider() : null}</>}</For>
                  </Show>
                </Show>
                <Show when={grouped().snoozed.length > 0}>
                  <box width="100%" minWidth={0} flexDirection="column" marginTop={1} paddingTop={1} paddingBottom={1} border={["top"]} borderColor={c.border}>
                    <box width="100%" minWidth={0} flexDirection="row" gap={1} onMouseUp={() => toggle("snoozedOpen")}>
                      <text fg={c.muted}><b>{sectionOpen("snoozed", store.snoozedOpen) ? "▾" : "▸"} Snoozed</b></text>
                      <text fg={c.muted}>({grouped().snoozed.length})</text>
                    </box>
                    <Show when={sectionOpen("snoozed", store.snoozedOpen)}>
                      <For each={grouped().snoozed}>{(session, index) => <>{row(session, "snoozed")}{index() < grouped().snoozed.length - 1 ? <box width="100%" height={1} border={["bottom"]} borderColor={c.border} /> : null}</>}</For>
                    </Show>
                  </box>
                </Show>
                <box width="100%" minWidth={0} flexDirection="row" justifyContent="space-between" marginTop={1} paddingTop={1} paddingBottom={1} border={["top"]} borderColor={c.border} onMouseUp={() => toggle("archivedOpen")}>
                  <box flexDirection="row" gap={1}>
                    <text fg={c.muted}><b>{sectionOpen("archived", store.archivedOpen) ? "▾" : "▸"} Archive</b></text>
                    <text fg={c.muted}>({grouped().archived.length})</text>
                  </box>
                </box>
                <Show when={sectionOpen("archived", store.archivedOpen)}>
                  <For each={grouped().archived}>{(session, index) => <>{row(session, "archived")}{index() < grouped().archived.length - 1 ? <box width="100%" height={1} border={["bottom"]} borderColor={c.border} /> : null}</>}</For>
                </Show>
                <box width="100%" height={1} flexShrink={0} />
              </scrollbox>
              <box width="100%" minWidth={0} flexDirection="column" paddingTop={1} paddingBottom={1}>
                <box width="100%" minWidth={0} height={1} flexDirection="row" alignItems="center" gap={1}>
                  <text fg={c.muted}><b>SETUP</b></text>
                  <box flexGrow={1} flexShrink={1} minWidth={0} height={1} border={["top"]} borderColor={c.border} />
                  <text fg={c.muted}>{active().scope}</text>
                </box>
                <box width="100%" minWidth={0} height={3} flexDirection="row" alignItems="center" gap={1}>
                  <box flexGrow={1} flexShrink={1} minWidth={0} height={3} flexDirection="row" alignItems="center" justifyContent="space-between" paddingLeft={2} paddingRight={2} border={true} borderStyle="rounded" borderColor={c.border} onMouseUp={switchSetup}>
                    <box flexDirection="row" alignItems="center" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
                      <text fg={c.primary}><b>{active().icon}</b></text>
                      <text flexGrow={1} flexShrink={1} minWidth={0} truncate wrapMode="none" fg={c.text}><b>{active().name}</b></text>
                    </box>
                    <text fg={c.muted}>⌄</text>
                  </box>
                  <box width={5} height={3} flexShrink={0} alignItems="center" justifyContent="center" border={true} borderStyle="rounded" borderColor={c.border} onMouseUp={() => void createSetupWizard()}>
                    <text fg={c.primary}><b>+</b></text>
                  </box>
                </box>
              </box>
            </box>
          </Show>
        );
      },
    });

    syncHostLayout();

    return () => {
      disposed = true;
      if (snoozeTimer) clearInterval(snoozeTimer);
      clearInterval(spinnerTimer);
      sidebarStatus.dispose();
      if (pressedActionTimer) clearTimeout(pressedActionTimer);
      if (sidebarScrollRestoreTimer) clearTimeout(sidebarScrollRestoreTimer);
      stopListening?.();
      for (const stop of sessionStops) stop();
    };
  },
};

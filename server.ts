import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type SetupDef = {
  id: string;
  name: string;
  prompt?: string;
  leadAgent?: string;
  agents?: string[];
  skills?: string[];
  tools?: string[];
};

const DEFAULT_SETUP_ID = "software-factory";
const STOCK_SETUP_ID = "default";
const STOCK_AGENT = "build";

// Built-in fallback definitions ensuring setups work even if disk reads fail.
const BUILTIN_SETUPS: Record<string, SetupDef> = {
  [DEFAULT_SETUP_ID]: {
    id: DEFAULT_SETUP_ID,
    name: "Software Factory",
    leadAgent: "Product Manager",
    prompt:
      "Work as a pragmatic software factory team led by the Product Manager. Keep changes focused, tested, and easy to maintain. Prefer the smallest coherent fix, fit existing patterns, and verify real behavior before calling work done.",
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
    tools: ["filesystem", "terminal"],
  },
  [STOCK_SETUP_ID]: {
    id: STOCK_SETUP_ID,
    name: "Default",
    leadAgent: STOCK_AGENT,
    prompt: "",
    agents: [],
    skills: [],
    tools: [],
  },
};

// Abstract capability tool groups mapped to canonical tool patterns and prefixes.
const CAPABILITY_TOOL_GROUPS: Record<string, string[]> = {
  terminal: ["shell", "bash", "exec", "terminal"],
  filesystem: ["read", "write", "edit", "glob", "grep", "file", "list_dir"],
  browser: ["browser", "playwright", "chrome-devtools"],
  computer: ["computer", "cu", "peekaboo"],
};

// "Stock" here means plain OpenCode: no setup prompt injection, no
// skill selections or agent mentions carried into the draft, and no
// MCP-provided tools in the model's per-request tool snapshot. Base
// file/shell tools are untouched, and nothing global changes — MCP
// servers stay connected in /mcps and config files are unmodified.

// Fallback MCP server names used to build the stock-mode strip prefixes
// when live discovery via ctx.mcp.list() is unavailable.
const STOCK_MCP_FALLBACK = ["chrome-devtools"];

// Cached MCP server names discovered once at setup; refreshed never —
// servers are config-level and stable for the process lifetime.
let mcpServerNames: string[] = [...STOCK_MCP_FALLBACK];

const discoverMcpServers = async (ctx: any) => {
  try {
    const result = await ctx?.mcp?.list?.();
    const entries = Array.isArray(result) ? result : result?.data;
    if (!Array.isArray(entries) || entries.length === 0) return;
    const names: string[] = [];
    for (const entry of entries) {
      if (Array.isArray(entry) && typeof entry[0] === "string") names.push(entry[0]);
      else if (typeof entry?.name === "string") names.push(entry.name);
      else if (typeof entry?.id === "string") names.push(entry.id);
      else if (typeof entry === "string") names.push(entry);
    }
    if (names.length > 0) mcpServerNames = [...new Set([...names, ...STOCK_MCP_FALLBACK])];
  } catch {
    // Discovery is best-effort; the static fallback still applies.
  }
};

const normalizeToolName = (raw: string): string => {
  let name = raw.trim();
  if (name.startsWith("tools.")) {
    name = name.slice(6);
  }
  return name;
};

const matchesPattern = (name: string, pattern: string): boolean => {
  const n = normalizeToolName(name).toLowerCase();
  const p = pattern.toLowerCase();
  if (n === p) return true;
  if (n.startsWith(`${p}_`) || n.startsWith(`${p}.`) || n.startsWith(`${p}-`)) return true;
  const pUnder = p.replace(/[-.]/g, "_");
  if (n.startsWith(`${pUnder}_`) || n.startsWith(`${pUnder}.`)) return true;
  return false;
};

const toolMatchesPatterns = (name: string, patterns: Iterable<string>): boolean => {
  for (const pat of patterns) {
    if (matchesPattern(name, pat)) return true;
  }
  return false;
};

const expandAllowed = (allowed: string[]): Set<string> => {
  const expanded = new Set<string>();
  for (const item of allowed) {
    const group = CAPABILITY_TOOL_GROUPS[item.toLowerCase()];
    if (group) {
      for (const pat of group) expanded.add(pat.toLowerCase());
    }
    expanded.add(item.toLowerCase());
  }
  return expanded;
};

const isMcpTool = (name: string): boolean => {
  const n = normalizeToolName(name).toLowerCase();
  for (const server of mcpServerNames) {
    const s = server.toLowerCase();
    if (n === s) return true;
    if (n.startsWith(`${s}_`) || n.startsWith(`${s}.`) || n.startsWith(`${s}-`)) return true;
    const sUnder = s.replace(/[-.]/g, "_");
    if (n.startsWith(`${sUnder}_`) || n.startsWith(`${sUnder}.`)) return true;
  }
  return false;
};

// Effective tool names carry their namespace with a "_" separator, and
// dots in namespaces become "_" (per the tool transform docs), so match
// both the raw server name and its normalized form.
const stockToolPrefixes = (): string[] => {
  const prefixes = new Set<string>();
  for (const name of mcpServerNames) {
    prefixes.add(`${name}_`);
    prefixes.add(`${name.replace(/\./g, "_")}_`);
    prefixes.add(`${name.replace(/[-.]/g, "_")}_`);
  }
  return [...prefixes];
};

const isStockTool = (name: string | undefined, prefixes: string[]): boolean => {
  if (!name) return false;
  const n = normalizeToolName(name).toLowerCase();
  if (prefixes.some((prefix) => n.startsWith(prefix.toLowerCase()))) return true;
  return isMcpTool(n);
};

// Tracks sessions already aligned to their setup's lead agent, so we switch
// at most once per session+setup. Manual agent switches afterwards are left
// alone (no yanking mid-work).
const alignedSessions = new Set<string>();

const alignAgent = async (ctx: any, sessionID: string | undefined, setup: SetupDef) => {
  try {
    const lead = setup.leadAgent;
    if (!lead || !sessionID || !ctx?.session?.switchAgent) return;
    const key = `${sessionID}:${setup.id}`;
    if (alignedSessions.has(key)) return;
    alignedSessions.add(key);
    let current: string | undefined;
    try {
      const info = await ctx.session.get?.({ sessionID });
      current = info?.agent || info?.data?.agent;
    } catch {
      // Unknown current agent — still try the switch once.
    }
    if (current && current === lead) return;

    // Do not yank an agent that is already a valid member of this setup.
    // Subagents (Tech Lead, Backend Guy, etc.) or manually switched agents
    // that belong to the setup should stay as they are.
    if (current && Array.isArray(setup.agents) && setup.agents.length > 0) {
      const allowed = new Set(setup.agents.map((a) => a.toLowerCase()));
      if (allowed.has(current.toLowerCase())) return;
    }

    // Otherwise, switch when current is empty, unknown, the stock default ("build"),
    // or not a valid member of the setup.
    await ctx.session.switchAgent({ sessionID, agent: lead });
  } catch {
    // Agent alignment is best-effort; never break a turn.
  }
};

// Definitions live on disk so the server side never depends on TUI state.
const loadSetup = (id: string, directory?: string): SetupDef | undefined => {
  const roots = [
    join(homedir(), ".config", "opencode", "setups"),
    join(directory || process.cwd(), ".opencode", "setups"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(root, name, "setup.json");
      if (!existsSync(path)) continue;
      try {
        if (!statSync(path).isFile()) continue;
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (value?.id === id) return value as SetupDef;
      } catch {
        // One malformed setup must not break startup or a turn.
      }
    }
  }
  return BUILTIN_SETUPS[id];
};

// The TUI owns per-session assignment in the shared "metadata" store:
// threads[sessionID].setupId, with activeSetup as the fallback default.
// Best-effort read — any unknown storage shape falls back silently.
const readSessionSetupId = async (ctx: any, sessionID: string | undefined): Promise<string | undefined> => {
  try {
    const storage = ctx?.storage;
    if (!storage) return undefined;
    if (typeof storage.store === "function") {
      const result = storage.store("metadata", { initial: { threads: {}, activeSetup: DEFAULT_SETUP_ID } });
      const store = Array.isArray(result) ? result[0] : result;
      const resolved = typeof store?.then === "function" ? await store : store;
      const data = Array.isArray(resolved) ? resolved[0] : resolved;
      if (sessionID && data?.threads?.[sessionID]?.setupId) return data.threads[sessionID].setupId;
      if (data?.activeSetup) return data.activeSetup;
    }
    if (typeof storage.get === "function") {
      const data = await storage.get("metadata");
      if (sessionID && data?.threads?.[sessionID]?.setupId) return data.threads[sessionID].setupId;
      if (data?.activeSetup) return data.activeSetup;
    }
  } catch {
    // Fall through to the default setup below.
  }
  return undefined;
};

const injectPrompt = (event: any, prompt: string) => {
  try {
    if (typeof event.system === "string") {
      if (!event.system.includes(prompt)) event.system = `${prompt}\n\n${event.system}`;
      return;
    }
    if (Array.isArray(event.system)) {
      const already = event.system.some(
        (part: any) => typeof part?.text === "string" && part.text.includes(prompt),
      );
      if (!already) event.system.unshift({ type: "text", text: prompt });
      return;
    }
    if (Array.isArray(event.messages)) {
      const first = event.messages[0];
      const firstText =
        typeof first?.content === "string"
          ? first.content
          : Array.isArray(first?.content)
            ? first.content.map((p: any) => p?.text || "").join("")
            : "";
      if (!firstText.includes(prompt)) event.messages.unshift({ role: "system", content: prompt });
    }
  } catch {
    // Prompt injection is best-effort; never break a turn.
  }
};

const toolName = (tool: any): string | undefined => {
  if (typeof tool === "string") return tool;
  return tool?.name || tool?.id || tool?.function?.name || undefined;
};

const itemIdentifier = (item: any): string | undefined => {
  if (typeof item === "string") return item;
  if (typeof item?.id === "string") return item.id;
  if (typeof item?.name === "string") return item.name;
  return undefined;
};

// Stock-mode stripping: remove MCP-provided tools from the outgoing
// per-request snapshot only (event.tools is mutated in place; global
// tool state is never touched). Conservative: when in doubt the tool
// stays, and we never strip the snapshot bare.
const stripStockTools = (event: any) => {
  try {
    const tools = event?.tools;
    if (!tools) return;
    const prefixes = stockToolPrefixes();
    if (Array.isArray(tools)) {
      const keep = tools.filter((tool: any) => !isStockTool(toolName(tool), prefixes));
      if (keep.length > 0) event.tools = keep;
      return;
    }
    if (typeof tools === "object") {
      const keys = Object.keys(tools);
      if (keys.length === 0) return;
      const doomed = keys.filter((key) => isStockTool(key, prefixes));
      if (doomed.length === 0 || doomed.length >= keys.length) return;
      for (const key of doomed) delete tools[key];
    }
  } catch {
    // Tool stripping is best-effort; never break a turn.
  }
};

// Stock-mode admission: drop skill selections and agent mentions from
// the prompt draft so Default sessions start clean.
const stripStockDraft = (event: any) => {
  try {
    const prompt = event?.prompt;
    if (!prompt || typeof prompt !== "object") return;
    if (Array.isArray(prompt.skills) && prompt.skills.length > 0) prompt.skills = [];
    if (Array.isArray(prompt.agents) && prompt.agents.length > 0) prompt.agents = [];
  } catch {
    // Draft stripping is best-effort; never break admission.
  }
};

// Non-default setup draft filtering: restrict skills and agents to those
// declared in the setup definition (when non-empty).
const filterSetupDraft = (event: any, setup: SetupDef) => {
  try {
    const prompt = event?.prompt;
    if (!prompt || typeof prompt !== "object") return;

    if (Array.isArray(prompt.skills) && Array.isArray(setup.skills) && setup.skills.length > 0) {
      const allowedSkills = new Set(setup.skills.map((s) => s.toLowerCase()));
      prompt.skills = prompt.skills.filter((item: any) => {
        const id = itemIdentifier(item);
        return id ? allowedSkills.has(id.toLowerCase()) : false;
      });
    }

    if (Array.isArray(prompt.agents) && Array.isArray(setup.agents) && setup.agents.length > 0) {
      const allowedAgents = new Set(setup.agents.map((a) => a.toLowerCase()));
      if (typeof setup.leadAgent === "string" && setup.leadAgent.trim().length > 0) {
        allowedAgents.add(setup.leadAgent.toLowerCase());
      }
      prompt.agents = prompt.agents.filter((item: any) => {
        const id = itemIdentifier(item);
        return id ? allowedAgents.has(id.toLowerCase()) : false;
      });
    }
  } catch {
    // Draft filtering is best-effort; never break admission.
  }
};

// Setup tools are abstract capability groups ("terminal", "filesystem", "browser", "computer")
// or explicit tool names. Filter event.tools (Record<string, any> or Array) to enforce allowed
// capabilities while keeping built-in utilities conservative and stripping unallowed MCP servers.
// Safeguard: never strip all tools bare (preserve original tools if filtering leaves 0 tools).
const filterTools = (event: any, allowed: string[] | undefined) => {
  try {
    if (!allowed || allowed.length === 0 || !event?.tools) return;

    const allowedPatterns = expandAllowed(allowed);

    // Collect patterns for known capability groups that are not allowed.
    const disallowedPatterns = new Set<string>();
    for (const [groupName, groupPatterns] of Object.entries(CAPABILITY_TOOL_GROUPS)) {
      if (!allowed.some((a) => a.toLowerCase() === groupName.toLowerCase())) {
        for (const pat of groupPatterns) {
          if (!allowedPatterns.has(pat.toLowerCase())) {
            disallowedPatterns.add(pat.toLowerCase());
          }
        }
      }
    }

    const shouldKeep = (rawName: string | undefined): boolean => {
      if (!rawName) return true;
      const name = normalizeToolName(rawName);

      // 1. Matches allowed capability groups or explicitly allowed names
      if (toolMatchesPatterns(name, allowedPatterns)) return true;

      // 2. Belongs to a disallowed capability category
      if (toolMatchesPatterns(name, disallowedPatterns)) return false;

      // 3. Belongs to an unallowed MCP server
      if (isMcpTool(name)) return false;

      // 4. Conservative: keep unknown/unmatched built-in utilities
      return true;
    };

    if (Array.isArray(event.tools)) {
      const keep = event.tools.filter((tool: any) => shouldKeep(toolName(tool)));
      // Safeguard: never strip all tools bare
      if (keep.length > 0 && keep.length < event.tools.length) {
        event.tools = keep;
      }
      return;
    }

    if (typeof event.tools === "object" && event.tools !== null) {
      const keys = Object.keys(event.tools);
      if (keys.length === 0) return;
      const doomed = keys.filter((key) => !shouldKeep(key));
      // Safeguard: never strip all tools bare
      if (doomed.length === 0 || doomed.length >= keys.length) return;
      for (const key of doomed) {
        delete event.tools[key];
      }
    }
  } catch {
    // Tool filtering is best-effort; never break a turn.
  }
};

export default {
  id: "opencode.setups",
  setup: async (ctx: any) => {
    try {
      if (!ctx?.session?.hook) return;
      await discoverMcpServers(ctx);

      // OpenCode creates a session before the first prompt/context hook runs.
      // Set the server's creation default here so a brand-new chat is born on
      // the factory lead, rather than briefly starting on the built-in `build`
      // agent. This is a creation default only: setup changes and explicit
      // session switches still take precedence, and alignAgent remains the
      // per-setup fallback for sessions that need it.
      if (typeof ctx?.agent?.transform === "function") {
        await ctx.agent.transform((editor: any) => {
          if (editor?.get?.("Product Manager") && typeof editor.default === "function") {
            editor.default("Product Manager");
          }
        });
      }

      // Admission-time: Default sessions enter with no skill selections
      // or agent mentions; non-default setups filter skills & agents to their declared set.
      await ctx.session.hook("prompt", async (event: any) => {
        try {
          const sessionID: string | undefined =
            event?.sessionID || event?.session?.id || event?.session?.sessionID;
          const storedId = await readSessionSetupId(ctx, sessionID);
          const setup =
            (storedId ? loadSetup(storedId, ctx?.location?.directory) : undefined) ||
            loadSetup(DEFAULT_SETUP_ID, ctx?.location?.directory);

          if (storedId === STOCK_SETUP_ID || setup?.id === STOCK_SETUP_ID) {
            stripStockDraft(event);
            return;
          }

          if (setup) {
            filterSetupDraft(event, setup);
          }
        } catch {
          // Per-admission failures fall back silently to unmodified behavior.
        }
      });

      // Context-time: Default setup strips MCP tools and aligns agent to stock.
      // Non-default setups inject system prompt, filter tools by capability groups, and align lead agent.
      await ctx.session.hook("context", async (event: any) => {
        try {
          const sessionID: string | undefined =
            event?.sessionID || event?.session?.id || event?.session?.sessionID;
          const storedId = await readSessionSetupId(ctx, sessionID);
          const setup =
            (storedId ? loadSetup(storedId, ctx?.location?.directory) : undefined) ||
            loadSetup(DEFAULT_SETUP_ID, ctx?.location?.directory);
          if (!setup) return;

          // Stock Default setup: no prompt injection, no factory tool
          // filtering — plain OpenCode. Strip MCP tools from this
          // request's snapshot, then align the agent back to stock, once.
          if (setup.id === STOCK_SETUP_ID) {
            stripStockTools(event);
            await alignAgent(ctx, sessionID, setup);
            return;
          }

          if (setup.prompt) injectPrompt(event, setup.prompt);
          filterTools(event, setup.tools);
          await alignAgent(ctx, sessionID, setup);
        } catch {
          // Per-turn failures fall back silently to unmodified behavior.
        }
      });
    } catch (err) {
      console.error("[opencode-setups] server hook registration failed:", err);
    }
  },
};

import { describe, expect, test } from "bun:test";
import plugin from "../server";

describe("server defaults", () => {
  test("registers Product Manager as the session creation default", async () => {
    let transform: ((editor: any) => void) | undefined;
    const hooks: string[] = [];

    await plugin.setup({
      mcp: {},
      agent: {
        transform: async (callback: (editor: any) => void) => { transform = callback; },
      },
      session: {
        hook: async (name: string) => { hooks.push(name); },
      },
    });

    expect(hooks).toEqual(["prompt", "context"]);
    expect(transform).toBeDefined();

    let selected: string | undefined;
    transform!({
      get: (id: string) => id === "Product Manager" ? { id } : undefined,
      default: (id: string) => { selected = id; },
    });
    expect(selected).toBe("Product Manager");
  });

  test("does not select a missing Product Manager agent", async () => {
    let transform: ((editor: any) => void) | undefined;
    await plugin.setup({
      mcp: {},
      agent: { transform: async (callback: (editor: any) => void) => { transform = callback; } },
      session: { hook: async () => {} },
    });

    let selected = false;
    transform!({ get: () => undefined, default: () => { selected = true; } });
    expect(selected).toBe(false);
  });

  test("alignAgent does not switch a valid setup member to lead agent", async () => {
    let contextHook: ((event: any) => Promise<void>) | undefined;
    const switched: any[] = [];

    await plugin.setup({
      mcp: {},
      agent: { transform: async () => {} },
      session: {
        hook: async (name: string, cb: any) => {
          if (name === "context") contextHook = cb;
        },
        get: async ({ sessionID }: { sessionID: string }) => {
          if (sessionID === "subagent-tech-lead") return { agent: "Tech Lead" };
          if (sessionID === "subagent-unknown") return { agent: "build" };
          return {};
        },
        switchAgent: async (args: any) => {
          switched.push(args);
        },
      },
    });

    expect(contextHook).toBeDefined();

    // 1. Subagent session with agent="Tech Lead" should NOT be switched
    await contextHook!({ sessionID: "subagent-tech-lead", system: "" });
    expect(switched).toEqual([]);

    // 2. Fresh session starting on stock "build" SHOULD switch to Product Manager
    await contextHook!({ sessionID: "subagent-unknown", system: "" });
    expect(switched).toEqual([{ sessionID: "subagent-unknown", agent: "Product Manager" }]);
  });

  test("filterSetupDraft allows all expanded software-factory subagents", async () => {
    let promptHook: ((event: any) => Promise<void>) | undefined;

    await plugin.setup({
      mcp: {},
      agent: { transform: async () => {} },
      session: {
        hook: async (name: string, cb: any) => {
          if (name === "prompt") promptHook = cb;
        },
      },
    });

    expect(promptHook).toBeDefined();

    const event = {
      sessionID: "test-session",
      prompt: {
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
          "Nonexistent Agent",
        ],
      },
    };

    await promptHook!(event);
    expect(event.prompt.agents).toEqual([
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
    ]);
  });
});

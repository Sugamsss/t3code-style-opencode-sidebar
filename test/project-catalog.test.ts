import { describe, expect, test } from "bun:test";
import { createProjectResolver, effectiveProjectFilter, historicalProject, isWithinPath, normalizeProjectPath, resolveProject, type ProjectEntry } from "../project-catalog";

const noProject: ProjectEntry = { id: "__no_project__", name: "No project", path: "/Users/test", groupId: "none" };
const project = (path: string, groupId = "other"): ProjectEntry => ({ id: path, name: path.split("/").at(-1)!, path, groupId });

describe("project catalog identity", () => {
  test("normalizes trailing separators and respects path boundaries", () => {
    expect(normalizeProjectPath("/tmp/workspace/" )).toBe("/tmp/workspace");
    expect(isWithinPath("/tmp/app/client", "/tmp/app")).toBe(true);
    expect(isWithinPath("/tmp/apple", "/tmp/app")).toBe(false);
  });

  test("prefers the most specific nested project", () => {
    const result = resolveProject([
      project("/tmp/workspace"),
      project("/tmp/workspace/client", "production"),
    ], "/tmp/workspace/client/src", undefined, "/Users/test", noProject);
    expect(result.id).toBe("/tmp/workspace/client");
  });

  test("reusable resolver preserves boundaries and nested specificity", () => {
    const resolver = createProjectResolver([
      project("/tmp/workspace"),
      project("/tmp/workspace/client", "production"),
    ], "/Users/test", noProject);
    expect(resolver("/tmp/workspace/client/src").id).toBe("/tmp/workspace/client");
    expect(resolver("/tmp/workspace/clients").groupId).toBe("other");
  });

  test("does not let a global backend id hide a real directory", () => {
    const result = resolveProject([project("/tmp/real-project", "production")], "/tmp/real-project", "global", "/Users/test", noProject);
    expect(result.id).toBe("/tmp/real-project");
  });

  test("keeps missing historical directories displayable", () => {
    const result = historicalProject("/tmp/no-longer-present-project/");
    expect(result).toMatchObject({ id: "/tmp/no-longer-present-project", name: "no-longer-present-project", available: false });
  });

  test("uses the explicit scratch destination only for home", () => {
    expect(resolveProject([], "/Users/test", "global", "/Users/test", noProject)).toBe(noProject);
    expect(resolveProject([], "/Users/test/project", "global", "/Users/test", noProject).id).toBe("/Users/test/project");
  });

  test("does not expose a stale filter as All chats while filtering", () => {
    expect(effectiveProjectFilter("/tmp/missing", [noProject])).toBe("all");
    expect(effectiveProjectFilter("/tmp/project", [project("/tmp/project")])).toBe("/tmp/project");
  });
});

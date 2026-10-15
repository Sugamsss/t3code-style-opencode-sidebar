import { describe, expect, test } from "bun:test";
import { buildProjectOptions, resolveProjectDestination } from "../project-picker";
import type { ProjectEntry, ProjectGroup } from "../project-catalog";

const noProject: ProjectEntry = { id: "__no_project__", name: "No project", path: "/home/test", groupId: "none" };
const groups: ProjectGroup[] = [
  { id: "curated", name: "CURATED", icon: "◈", root: "/projects", projects: [
    { id: "/projects/alpha", name: "alpha", path: "/projects/alpha", groupId: "curated", available: true },
  ] },
  { id: "other", name: "OTHER PROJECTS", icon: "◇", root: "", projects: [
    { id: "/archive/old", name: "old", path: "/archive/old", groupId: "other", available: true },
  ] },
];

describe("shared project picker", () => {
  test("filter and new-chat choices share project options apart from All chats", () => {
    const filter = buildProjectOptions(groups, noProject, { includeAll: true });
    const newChat = buildProjectOptions(groups, noProject);
    expect(filter.slice(1)).toEqual(newChat);
    expect(filter[0]).toMatchObject({ value: "all", title: "All chats" });
  });

  test("resolves scratch, curated, and Other projects, but not filter sentinels", () => {
    const projects = [noProject, ...groups.flatMap((group) => group.projects)];
    const isDirectory = (path: string) => path !== "/archive/missing";
    expect(resolveProjectDestination(noProject.id, projects, noProject, isDirectory)).toBe("/home/test");
    expect(resolveProjectDestination("/projects/alpha", projects, noProject, isDirectory)).toBe("/projects/alpha");
    expect(resolveProjectDestination("/archive/old", projects, noProject, isDirectory)).toBe("/archive/old");
    expect(resolveProjectDestination("all", projects, noProject, isDirectory)).toBeUndefined();
    expect(resolveProjectDestination(undefined, projects, noProject, isDirectory)).toBeUndefined();
    expect(resolveProjectDestination("/unknown", projects, noProject, isDirectory)).toBeUndefined();
  });

  test("rejects a removed destination", () => {
    const missing: ProjectEntry = { id: "/archive/missing", name: "missing", path: "/archive/missing", groupId: "other", available: true };
    expect(resolveProjectDestination(missing.id, [missing], noProject, () => false)).toBeUndefined();
    expect(resolveProjectDestination(missing.id, [{ ...missing, available: false }], noProject, () => true)).toBeUndefined();
  });
});

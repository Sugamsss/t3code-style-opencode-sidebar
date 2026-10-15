import { basename, dirname, normalize, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";

export type ProjectEntry = { id: string; name: string; path: string; groupId: string; available?: boolean };
export type ProjectGroup = { id: string; name: string; icon: string; root: string; projects: ProjectEntry[] };

/** Normalize lexical aliases, and resolve symlinks only for directories that exist. */
export const normalizeProjectPath = (value: string) => {
  const lexical = normalize(resolve(value));
  try { return realpathSync(lexical); } catch { return lexical; }
};

export const isWithinPath = (directory: string, root: string) => {
  const child = normalizeProjectPath(directory);
  const parent = normalizeProjectPath(root);
  return child === parent || child.startsWith(`${parent}/`);
};

/**
 * A normalized project lookup that can be reused for every session in a
 * catalog snapshot. Project paths are indexed by their ancestors, so a
 * lookup does not normalize or realpath every catalog entry on each render.
 */
export type ProjectResolver = (directory: string | undefined, projectID?: string) => ProjectEntry;

export const createProjectResolver = (
  projects: ProjectEntry[], home: string, noProject: ProjectEntry,
): ProjectResolver => {
  const byPath = new Map<string, ProjectEntry>();
  const normalizedPaths = new Map<string, string>();
  const normalized = (value: string) => {
    const cached = normalizedPaths.get(value);
    if (cached) return cached;
    const result = normalizeProjectPath(value);
    normalizedPaths.set(value, result);
    return result;
  };
  for (const project of projects) {
    const path = normalized(project.path);
    if (!byPath.has(path)) byPath.set(path, project);
  }
  const noProjectPath = normalized(noProject.path);
  const homePath = normalized(home);

  return (directory, projectID) => {
    if (!directory) return noProject;
    const normalizedDirectory = normalized(directory);
    if (normalizedDirectory === noProjectPath) return noProject;

    let candidate = normalizedDirectory;
    while (candidate !== dirname(candidate)) {
      const project = byPath.get(candidate);
      if (project) return project;
      candidate = dirname(candidate);
    }
    const rootProject = byPath.get(candidate);
    if (rootProject) return rootProject;

    if (projectID === "global" && normalizedDirectory === homePath) return noProject;
    return { id: normalizedDirectory, name: basename(normalizedDirectory), path: normalizedDirectory, groupId: "other", available: existsSync(normalizedDirectory) };
  };
};

export const resolveProject = (
  projects: ProjectEntry[], directory: string | undefined, projectID: string | undefined,
  home: string, noProject: ProjectEntry,
): ProjectEntry => {
  return createProjectResolver(projects, home, noProject)(directory, projectID);
};

export const historicalProject = (directory: string, groupId = "other"): ProjectEntry => {
  const path = normalizeProjectPath(directory);
  return { id: path, name: basename(path), path, groupId, available: existsSync(path) };
};

export const effectiveProjectFilter = (filter: string | undefined, projects: ProjectEntry[]) => {
  if (!filter || filter === "all") return "all";
  return projects.some((project) => project.id === filter) ? filter : "all";
};

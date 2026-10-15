import { statSync } from "node:fs";
import type { ProjectEntry, ProjectGroup } from "./project-catalog";

export type ProjectPickerOption = {
  title: string;
  description: string;
  category?: string;
  value: string;
};

type ProjectOptionConfig = { includeAll?: boolean };

/** Build the shared project choices without refreshing or inspecting the filesystem. */
export const buildProjectOptions = (
  groups: ProjectGroup[],
  noProject: ProjectEntry,
  { includeAll = false }: ProjectOptionConfig = {},
): ProjectPickerOption[] => [
  ...(includeAll ? [{
    title: "All chats",
    description: "Show conversations from every project",
    value: "all",
  }] : []),
  {
    title: "○  No project",
    description: "Global scratch space · no project folder",
    category: "SPECIAL",
    value: noProject.id,
  },
  ...groups.flatMap((group) => group.projects.map((project) => ({
    title: `${group.icon}  ${project.name}`,
    description: project.path,
    category: group.name,
    value: project.id,
  }))),
];

const defaultIsDirectory = (path: string) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

/** Resolve a picker reference, keeping the All chats sentinel out of navigation. */
export const resolveProjectDestination = (
  reference: string | undefined,
  projects: ProjectEntry[],
  noProject: ProjectEntry,
  isDirectory: (path: string) => boolean = defaultIsDirectory,
): string | undefined => {
  if (!reference || reference === "all") return undefined;
  const project = projects.find((item) => item.id === reference);
  if (!project) return undefined;
  if (project.id === noProject.id) return project.path;
  if (project.available === false || !isDirectory(project.path)) return undefined;
  return project.path;
};

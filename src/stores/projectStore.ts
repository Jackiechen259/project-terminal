/**
 * Zustand store for projects.
 *
 * The store holds projects loaded from the backend and tracks the active
 * project id. It does NOT duplicate terminal/tab state - that lives in
 * `terminalStore` and is keyed by project id.
 */

import { create } from "zustand";

import {
  projectService,
  type FrontendError,
  type ProjectInput,
} from "@/services";
import type { Project } from "@/types";

export interface ProjectStoreState {
  projects: Project[];
  activeProjectId: string | null;
  loading: boolean;
  error: FrontendError | null;

  loadProjects: () => Promise<void>;
  setActiveProject: (id: string | null) => void;
  createProject: (input: ProjectInput) => Promise<Project>;
  updateProject: (input: ProjectInput) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  clearError: () => void;
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  projects: [],
  activeProjectId: null,
  loading: false,
  error: null,

  loadProjects: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await projectService.list();
      set({ projects, loading: false });
    } catch (e) {
      set({ loading: false, error: e as FrontendError });
    }
  },

  setActiveProject: (id) => set({ activeProjectId: id }),

  createProject: async (input) => {
    const project = await projectService.create(input);
    set({ projects: [...get().projects, project] });
    return project;
  },

  updateProject: async (input) => {
    const updated = await projectService.update(input);
    set({
      projects: get().projects.map((p) => (p.id === updated.id ? updated : p)),
    });
    return updated;
  },

  deleteProject: async (id) => {
    await projectService.delete(id);
    const remaining = get().projects.filter((p) => p.id !== id);
    set({
      projects: remaining,
      activeProjectId:
        get().activeProjectId === id
          ? (remaining[0]?.id ?? null)
          : get().activeProjectId,
    });
  },

  clearError: () => set({ error: null }),
}));

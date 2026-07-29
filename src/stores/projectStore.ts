/**
 * Zustand store for projects.
 *
 * The store holds projects loaded from the backend. Workspace selection and
 * terminal/tab state live in `terminalStore`, keyed by project id.
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
  loading: boolean;
  /**
   * True once the backend list has been read at least once. Consumers that
   * reconcile persisted state against the project list (sidebar collections)
   * must wait for this - an empty `projects` before the first load says
   * "not loaded yet", not "no projects exist".
   */
  loaded: boolean;
  error: FrontendError | null;

  loadProjects: () => Promise<void>;
  createProject: (input: ProjectInput) => Promise<Project>;
  updateProject: (input: ProjectInput) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  clearError: () => void;
}

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  projects: [],
  loading: false,
  loaded: false,
  error: null,

  loadProjects: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await projectService.list();
      set({ projects, loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, error: e as FrontendError });
    }
  },

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
    set({ error: null });
    try {
      await projectService.delete(id);
      set({ projects: get().projects.filter((p) => p.id !== id) });
    } catch (error) {
      set({ error: error as FrontendError });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));

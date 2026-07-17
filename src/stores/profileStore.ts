/**
 * Zustand store for terminal profiles. Profiles are loaded per-project on
 * demand (a project may have many profiles) and cached in `byProjectId`.
 */

import { create } from "zustand";

import {
  profileService,
  type FrontendError,
  type ProfileInput,
} from "@/services";
import type { TerminalProfile } from "@/types";

export interface ProfileStoreState {
  byProjectId: Record<string, TerminalProfile[]>;
  loadingProjectIds: Set<string>;
  error: FrontendError | null;

  loadForProject: (projectId: string) => Promise<void>;
  createProfile: (input: ProfileInput) => Promise<TerminalProfile>;
  updateProfile: (input: ProfileInput) => Promise<TerminalProfile>;
  deleteProfile: (id: string, projectId: string) => Promise<void>;
  defaultForProject: (projectId: string) => TerminalProfile | null;
  clearError: () => void;
}

export const useProfileStore = create<ProfileStoreState>((set, get) => ({
  byProjectId: {},
  loadingProjectIds: new Set(),
  error: null,

  loadForProject: async (projectId) => {
    set({
      loadingProjectIds: new Set([...get().loadingProjectIds, projectId]),
      error: null,
    });
    try {
      const profiles = await profileService.list(projectId);
      set({
        byProjectId: { ...get().byProjectId, [projectId]: profiles },
      });
    } catch (e) {
      set({ error: e as FrontendError });
    } finally {
      const next = new Set(get().loadingProjectIds);
      next.delete(projectId);
      set({ loadingProjectIds: next });
    }
  },

  createProfile: async (input) => {
    const profile = await profileService.create(input);
    const existing = get().byProjectId[profile.projectId] ?? [];
    // Clear isDefault on siblings when the new profile is the default.
    const siblings = profile.isDefault
      ? existing.map((p) => ({ ...p, isDefault: false }))
      : existing;
    const updated = [...siblings, profile];
    set({
      byProjectId: { ...get().byProjectId, [profile.projectId]: updated },
    });
    return profile;
  },

  updateProfile: async (input) => {
    const profile = await profileService.update(input);
    const projectId = profile.projectId;
    const existing = get().byProjectId[projectId] ?? [];
    const updated = existing.map((p) =>
      p.id === profile.id
        ? profile
        : profile.isDefault
          ? { ...p, isDefault: false }
          : p,
    );
    set({
      byProjectId: { ...get().byProjectId, [projectId]: updated },
    });
    return profile;
  },

  deleteProfile: async (id, projectId) => {
    await profileService.delete(id);
    const existing = get().byProjectId[projectId] ?? [];
    set({
      byProjectId: {
        ...get().byProjectId,
        [projectId]: existing.filter((p) => p.id !== id),
      },
    });
  },

  defaultForProject: (projectId) => {
    const list = get().byProjectId[projectId] ?? [];
    return list.find((p) => p.isDefault) ?? list[0] ?? null;
  },

  clearError: () => set({ error: null }),
}));

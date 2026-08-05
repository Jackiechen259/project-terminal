/**
 * Colour schemes the user imported.
 *
 * Built-in schemes are not here: they are code in `@/lib/terminalColorSchemes`
 * and need no loading. This store holds only what came from Windows Terminal
 * or a file, which lives in the backend's config directory.
 *
 * Loaded on demand rather than at bootstrap - nothing needs it until either
 * the appearance settings open or a terminal resolves a selection that is not
 * a built-in.
 */

import { create } from "zustand";

import {
  toTerminalColorScheme,
  type TerminalColorScheme,
} from "@/lib/terminalColorSchemes";
import { colorSchemeService } from "@/services";

interface ColorSchemeStoreState {
  schemes: TerminalColorScheme[];
  loading: boolean;
  error: string | null;
  load: () => Promise<TerminalColorScheme[]>;
  remove: (id: string) => Promise<void>;
}

function errorMessage(cause: unknown): string {
  if (
    cause !== null &&
    typeof cause === "object" &&
    "message" in cause &&
    typeof (cause as { message?: unknown }).message === "string"
  ) {
    return (cause as { message: string }).message;
  }
  return typeof cause === "string" ? cause : "Unexpected error";
}

export const useColorSchemeStore = create<ColorSchemeStoreState>((set, get) => {
  let inflight: Promise<TerminalColorScheme[]> | null = null;
  return {
    schemes: [],
    loading: false,
    error: null,
    load: async () => {
      // Coalesce concurrent callers: several terminals can resolve the same
      // imported scheme at once on startup.
      if (inflight) return inflight;
      inflight = (async () => {
        set({ loading: true, error: null });
        try {
          const schemes = (await colorSchemeService.list()).map(
            toTerminalColorScheme,
          );
          set({ schemes, loading: false });
          return schemes;
        } catch (e) {
          // An unreadable schemes file must not cost the user their
          // terminals; the selection falls back to a built-in.
          set({ loading: false, error: errorMessage(e) });
          return get().schemes;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    remove: async (id) => {
      await colorSchemeService.delete(id);
      set((state) => ({ schemes: state.schemes.filter((s) => s.id !== id) }));
    },
  };
});

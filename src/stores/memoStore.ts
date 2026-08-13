/**
 * Zustand store for per-project memos.
 *
 * Memos are a UI-local resource: they live in localStorage (throttled), never
 * in the backend Project model, and are strictly isolated by `projectId`.
 * Deleting a backend project also clears its memos via `removeProjectMemos`,
 * but only after the backend delete has succeeded.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { createThrottledJSONStorage } from "@/lib/throttledStorage";

export const PROJECT_MEMO_STORAGE_KEY = "project-terminal.project-memos.v1";

/** Shared fields for every memo kind. */
export interface ProjectMemoBase {
  id: string;
  projectId: string;
  title: string;

  createdAt: number;
  updatedAt: number;
}

/** Free-form Markdown note. */
export interface MarkdownMemo extends ProjectMemoBase {
  kind: "markdown";
  content: string;
}

/** Reusable shell command with a description. */
export interface CommandMemo extends ProjectMemoBase {
  kind: "command";

  description: string;
  command: string;
}

export type ProjectMemo = MarkdownMemo | CommandMemo;

/**
 * Stable empty list so a selector returning
 * `memosByProjectId[projectId] ?? EMPTY_MEMOS` never allocates a fresh array
 * per render (which would re-render consumers on every store change).
 */
export const EMPTY_MEMOS: readonly ProjectMemo[] = [];

export interface MemoStoreState {
  memosByProjectId: Record<string, ProjectMemo[]>;

  /** Create an empty markdown memo for a project; returns its id. */
  createMarkdownMemo: (projectId: string) => string;
  /** Create an empty command memo for a project; returns its id. */
  createCommandMemo: (projectId: string) => string;

  updateMarkdownMemo: (
    projectId: string,
    memoId: string,
    patch: Partial<Pick<MarkdownMemo, "title" | "content">>,
  ) => void;

  updateCommandMemo: (
    projectId: string,
    memoId: string,
    patch: Partial<Pick<CommandMemo, "title" | "description" | "command">>,
  ) => void;

  deleteMemo: (projectId: string, memoId: string) => void;

  /** Drop every memo belonging to a project (after its backend delete). */
  removeProjectMemos: (projectId: string) => void;
}

/** `crypto.randomUUID()` with a timestamp fallback for odd environments. */
export function createMemoId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `memo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export const memoStoreStorage =
  createThrottledJSONStorage<Pick<MemoStoreState, "memosByProjectId">>();

export const useMemoStore = create<MemoStoreState>()(
  persist(
    (set, get) => ({
      memosByProjectId: {},

      createMarkdownMemo: (projectId) => {
        const now = Date.now();
        const memo: MarkdownMemo = {
          id: createMemoId(),
          projectId,
          kind: "markdown",
          title: "",
          content: "",
          createdAt: now,
          updatedAt: now,
        };
        const existing = get().memosByProjectId[projectId] ?? [];
        set({
          memosByProjectId: {
            ...get().memosByProjectId,
            [projectId]: [...existing, memo],
          },
        });
        return memo.id;
      },

      createCommandMemo: (projectId) => {
        const now = Date.now();
        const memo: CommandMemo = {
          id: createMemoId(),
          projectId,
          kind: "command",
          title: "",
          description: "",
          command: "",
          createdAt: now,
          updatedAt: now,
        };
        const existing = get().memosByProjectId[projectId] ?? [];
        set({
          memosByProjectId: {
            ...get().memosByProjectId,
            [projectId]: [...existing, memo],
          },
        });
        return memo.id;
      },

      updateMarkdownMemo: (projectId, memoId, patch) => {
        const list = get().memosByProjectId[projectId];
        const memo = list?.find((item) => item.id === memoId);
        if (!memo || memo.kind !== "markdown") return;
        // Skip no-op writes so autosave keystrokes that repeat the current
        // value do not bump `updatedAt` (and churn persisted output).
        if (
          (patch.title === undefined || patch.title === memo.title) &&
          (patch.content === undefined || patch.content === memo.content)
        ) {
          return;
        }
        set({
          memosByProjectId: {
            ...get().memosByProjectId,
            [projectId]: list.map((item) =>
              item.id === memoId
                ? { ...memo, ...patch, updatedAt: Date.now() }
                : item,
            ),
          },
        });
      },

      updateCommandMemo: (projectId, memoId, patch) => {
        const list = get().memosByProjectId[projectId];
        const memo = list?.find((item) => item.id === memoId);
        if (!memo || memo.kind !== "command") return;
        if (
          (patch.title === undefined || patch.title === memo.title) &&
          (patch.description === undefined ||
            patch.description === memo.description) &&
          (patch.command === undefined || patch.command === memo.command)
        ) {
          return;
        }
        set({
          memosByProjectId: {
            ...get().memosByProjectId,
            [projectId]: list.map((item) =>
              item.id === memoId
                ? { ...memo, ...patch, updatedAt: Date.now() }
                : item,
            ),
          },
        });
      },

      deleteMemo: (projectId, memoId) => {
        const list = get().memosByProjectId[projectId];
        if (!list) return;
        set({
          memosByProjectId: {
            ...get().memosByProjectId,
            [projectId]: list.filter((item) => item.id !== memoId),
          },
        });
      },

      removeProjectMemos: (projectId) => {
        if (!(projectId in get().memosByProjectId)) return;
        const memosByProjectId = { ...get().memosByProjectId };
        delete memosByProjectId[projectId];
        set({ memosByProjectId });
      },
    }),
    {
      name: PROJECT_MEMO_STORAGE_KEY,
      version: 1,
      storage: memoStoreStorage,
      partialize: (state): Pick<MemoStoreState, "memosByProjectId"> => ({
        memosByProjectId: state.memosByProjectId,
      }),
    },
  ),
);

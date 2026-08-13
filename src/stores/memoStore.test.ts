import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  memoStoreStorage,
  PROJECT_MEMO_STORAGE_KEY,
  useMemoStore,
  type MarkdownMemo,
} from "@/stores/memoStore";

beforeEach(() => {
  localStorage.clear();
  useMemoStore.setState({ memosByProjectId: {} });
});

describe("memoStore", () => {
  describe("createMarkdownMemo", () => {
    it("saves the projectId, generates a unique id, and stamps timestamps", () => {
      const a = useMemoStore.getState().createMarkdownMemo("project-a");
      const b = useMemoStore.getState().createMarkdownMemo("project-a");
      expect(a).not.toBe(b);
      const memo = useMemoStore.getState().memosByProjectId["project-a"][0] as
        MarkdownMemo;
      expect(memo.kind).toBe("markdown");
      expect(memo.id).toBe(a);
      expect(memo.projectId).toBe("project-a");
      expect(memo.title).toBe("");
      expect(memo.content).toBe("");
      expect(memo.createdAt).toBeGreaterThan(0);
      expect(memo.updatedAt).toBe(memo.createdAt);
    });

    it("falls back to a timestamp id when randomUUID is unavailable", () => {
      const original = crypto.randomUUID;
      vi.stubGlobal("crypto", { ...crypto, randomUUID: undefined });
      try {
        const id = useMemoStore.getState().createMarkdownMemo("p");
        expect(id).toMatch(/^memo-\d+-[a-z0-9]+$/);
      } finally {
        vi.unstubAllGlobals();
        crypto.randomUUID = original;
      }
    });
  });

  describe("createCommandMemo", () => {
    it("creates an empty command memo for the project", () => {
      const id = useMemoStore.getState().createCommandMemo("project-a");
      const memo = useMemoStore
        .getState()
        .memosByProjectId["project-a"].find((m) => m.id === id);
      expect(memo).toMatchObject({
        kind: "command",
        projectId: "project-a",
        title: "",
        description: "",
        command: "",
      });
    });
  });

  describe("project isolation", () => {
    it("never mixes memos of different projects", () => {
      useMemoStore.getState().createMarkdownMemo("project-a");
      useMemoStore.getState().createMarkdownMemo("project-b");
      useMemoStore.getState().createCommandMemo("project-a");

      const a = useMemoStore.getState().memosByProjectId["project-a"];
      const b = useMemoStore.getState().memosByProjectId["project-b"];
      expect(a).toHaveLength(2);
      expect(b).toHaveLength(1);
      expect(a.every((m) => m.projectId === "project-a")).toBe(true);
      expect(b.every((m) => m.projectId === "project-b")).toBe(true);
    });
  });

  describe("updateMarkdownMemo", () => {
    it("updates title and content and bumps updatedAt", () => {
      const id = useMemoStore.getState().createMarkdownMemo("p");
      useMemoStore.setState((state) => ({
        memosByProjectId: {
          ...state.memosByProjectId,
          p: state.memosByProjectId.p.map((m) =>
            m.id === id ? { ...m, updatedAt: 1 } : m,
          ),
        },
      }));
      useMemoStore
        .getState()
        .updateMarkdownMemo("p", id, { title: "API", content: "# Notes" });
      const memo = useMemoStore.getState().memosByProjectId.p[0] as
        MarkdownMemo;
      expect(memo.title).toBe("API");
      expect(memo.content).toBe("# Notes");
      expect(memo.updatedAt).toBeGreaterThan(1);
    });

    it("ignores a no-op patch so updatedAt is not bumped", () => {
      const id = useMemoStore.getState().createMarkdownMemo("p");
      useMemoStore.setState((state) => ({
        memosByProjectId: {
          ...state.memosByProjectId,
          p: state.memosByProjectId.p.map((m) =>
            m.id === id ? { ...m, content: "same", updatedAt: 7 } : m,
          ),
        },
      }));
      useMemoStore.getState().updateMarkdownMemo("p", id, {
        content: "same",
        title: "",
      });
      expect(useMemoStore.getState().memosByProjectId.p[0].updatedAt).toBe(7);
    });

    it("does not touch a command memo through the markdown API", () => {
      const id = useMemoStore.getState().createCommandMemo("p");
      useMemoStore
        .getState()
        .updateMarkdownMemo("p", id, { content: "nope" });
      expect(useMemoStore.getState().memosByProjectId.p[0].kind).toBe(
        "command",
      );
    });
  });

  describe("updateCommandMemo", () => {
    it("updates title, description and command, and bumps updatedAt", () => {
      const id = useMemoStore.getState().createCommandMemo("p");
      useMemoStore.setState((state) => ({
        memosByProjectId: {
          ...state.memosByProjectId,
          p: state.memosByProjectId.p.map((m) =>
            m.id === id ? { ...m, updatedAt: 1 } : m,
          ),
        },
      }));
      useMemoStore
        .getState()
        .updateCommandMemo("p", id, {
          title: "Dev server",
          description: "Start Vite",
          command: "pnpm dev",
        });
      const memo = useMemoStore.getState().memosByProjectId.p[0];
      expect(memo).toMatchObject({
        title: "Dev server",
        description: "Start Vite",
        command: "pnpm dev",
      });
      expect(memo.updatedAt).toBeGreaterThan(1);
    });

    it("ignores a no-op patch", () => {
      const id = useMemoStore.getState().createCommandMemo("p");
      useMemoStore.setState((state) => ({
        memosByProjectId: {
          ...state.memosByProjectId,
          p: state.memosByProjectId.p.map((m) =>
            m.id === id ? { ...m, title: "t", updatedAt: 3 } : m,
          ),
        },
      }));
      useMemoStore.getState().updateCommandMemo("p", id, { title: "t" });
      expect(useMemoStore.getState().memosByProjectId.p[0].updatedAt).toBe(3);
    });
  });

  describe("deleteMemo", () => {
    it("removes exactly one memo", () => {
      const keep = useMemoStore.getState().createMarkdownMemo("p");
      const remove = useMemoStore.getState().createMarkdownMemo("p");
      useMemoStore.getState().deleteMemo("p", remove);
      const ids = useMemoStore.getState().memosByProjectId.p.map((m) => m.id);
      expect(ids).toEqual([keep]);
    });
  });

  describe("removeProjectMemos", () => {
    it("removes only the target project's memos", () => {
      useMemoStore.getState().createMarkdownMemo("a");
      useMemoStore.getState().createCommandMemo("a");
      useMemoStore.getState().createMarkdownMemo("b");
      useMemoStore.getState().removeProjectMemos("a");
      expect(useMemoStore.getState().memosByProjectId.a).toBeUndefined();
      expect(useMemoStore.getState().memosByProjectId.b).toHaveLength(1);
    });
  });

  describe("persistence", () => {
    it("persists memos under the project-memos key", () => {
      const id = useMemoStore.getState().createCommandMemo("p");
      useMemoStore
        .getState()
        .updateCommandMemo("p", id, { command: "pnpm dev" });
      memoStoreStorage.flush();
      const raw = localStorage.getItem(PROJECT_MEMO_STORAGE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw as string);
      expect(parsed.state.memosByProjectId.p[0]).toMatchObject({
        kind: "command",
        command: "pnpm dev",
      });
    });
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import { useCollectionStore } from "@/stores/collectionStore";

beforeEach(() => {
  localStorage.clear();
  useCollectionStore.setState({
    collections: [],
    collapsed: {},
    ungroupedProjectIds: [],
  });
});

describe("collectionStore", () => {
  describe("createCollection", () => {
    it("creates a collection with a fresh id and timestamps", () => {
      const collection = useCollectionStore.getState().createCollection("Work");
      expect(collection.id).toMatch(/^col-/);
      expect(collection.name).toBe("Work");
      expect(collection.projectIds).toEqual([]);
      expect(collection.createdAt).toBe(collection.updatedAt);
      expect(useCollectionStore.getState().collections).toHaveLength(1);
    });

    it("falls back to a default name when blank", () => {
      const collection = useCollectionStore.getState().createCollection("   ");
      expect(collection.name).toBe("New collection");
    });
  });

  describe("renameCollection", () => {
    it("updates the name and bumps updatedAt", () => {
      const collection = useCollectionStore.getState().createCollection("A");
      // Force a stale updatedAt so we can assert the rename bumped it.
      useCollectionStore.setState({
        collections: [{ ...collection, updatedAt: "2020-01-01T00:00:00.000Z" }],
      });
      useCollectionStore.getState().renameCollection(collection.id, "B");
      const renamed = useCollectionStore.getState().collections[0];
      expect(renamed.name).toBe("B");
      expect(renamed.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
      // Updated timestamp must be a real ISO string after Jan 2020.
      expect(renamed.updatedAt > "2020-01-01T00:00:00.000Z").toBe(true);
    });

    it("ignores empty names", () => {
      const collection = useCollectionStore.getState().createCollection("A");
      useCollectionStore.getState().renameCollection(collection.id, "  ");
      expect(useCollectionStore.getState().collections[0].name).toBe("A");
    });
  });

  describe("deleteCollection", () => {
    it("removes the collection and its collapsed state", () => {
      const collection = useCollectionStore.getState().createCollection("A");
      useCollectionStore.getState().setCollapsed(collection.id, true);
      useCollectionStore.getState().deleteCollection(collection.id);
      expect(useCollectionStore.getState().collections).toEqual([]);
      expect(
        useCollectionStore.getState().collapsed[collection.id],
      ).toBeUndefined();
    });
  });

  describe("moveProjectToCollection", () => {
    it("appends a project to the target collection", () => {
      const a = useCollectionStore.getState().createCollection("A");
      useCollectionStore.getState().moveProjectToCollection("p1", a.id);
      useCollectionStore.getState().moveProjectToCollection("p2", a.id);
      expect(useCollectionStore.getState().collections[0].projectIds).toEqual([
        "p1",
        "p2",
      ]);
    });

    it("moves a project out of its previous collection", () => {
      const a = useCollectionStore.getState().createCollection("A");
      const b = useCollectionStore.getState().createCollection("B");
      useCollectionStore.getState().moveProjectToCollection("p1", a.id);
      useCollectionStore.getState().moveProjectToCollection("p1", b.id);
      expect(
        useCollectionStore.getState().collections.find((c) => c.id === a.id)
          ?.projectIds,
      ).toEqual([]);
      expect(
        useCollectionStore.getState().collections.find((c) => c.id === b.id)
          ?.projectIds,
      ).toEqual(["p1"]);
    });

    it("inserts before the specified project when given", () => {
      const a = useCollectionStore.getState().createCollection("A");
      useCollectionStore.getState().moveProjectToCollection("p1", a.id);
      useCollectionStore.getState().moveProjectToCollection("p2", a.id);
      useCollectionStore.getState().moveProjectToCollection("p3", a.id, "p1");
      expect(useCollectionStore.getState().collections[0].projectIds).toEqual([
        "p3",
        "p1",
        "p2",
      ]);
    });
    it("inserts after the specified project when position is 'after'", () => {
      const a = useCollectionStore.getState().createCollection("A");
      useCollectionStore.getState().moveProjectToCollection("p1", a.id);
      useCollectionStore.getState().moveProjectToCollection("p2", a.id);
      useCollectionStore
        .getState()
        .moveProjectToCollection("p3", a.id, "p1", "after");
      expect(useCollectionStore.getState().collections[0].projectIds).toEqual([
        "p1",
        "p3",
        "p2",
      ]);
    });

    it("appends when insertBeforeProjectId is not in the collection", () => {
      const a = useCollectionStore.getState().createCollection("A");
      useCollectionStore.getState().moveProjectToCollection("p1", a.id);
      useCollectionStore.getState().moveProjectToCollection("p2", a.id, "p99");
      expect(useCollectionStore.getState().collections[0].projectIds).toEqual([
        "p1",
        "p2",
      ]);
    });

    it("removes the project from all collections when target is null", () => {
      const a = useCollectionStore.getState().createCollection("A");
      useCollectionStore.getState().moveProjectToCollection("p1", a.id);
      useCollectionStore.getState().moveProjectToCollection("p1", null);
      expect(useCollectionStore.getState().collections[0].projectIds).toEqual(
        [],
      );
    });
  });

  describe("reorderCollection", () => {
    it("moves a collection to a new position", () => {
      const a = useCollectionStore.getState().createCollection("A");
      const b = useCollectionStore.getState().createCollection("B");
      const c = useCollectionStore.getState().createCollection("C");
      useCollectionStore.getState().reorderCollection(0, 2);
      const names = useCollectionStore
        .getState()
        .collections.map((col) => col.name);
      expect(names).toEqual(["B", "C", "A"]);
      // ids unchanged
      const ids = useCollectionStore
        .getState()
        .collections.map((col) => col.id);
      expect(ids).toEqual([b.id, c.id, a.id]);
    });

    it("ignores out-of-range or no-op indices", () => {
      useCollectionStore.getState().createCollection("A");
      useCollectionStore.getState().createCollection("B");
      const before = useCollectionStore.getState().collections;
      useCollectionStore.getState().reorderCollection(-1, 0);
      useCollectionStore.getState().reorderCollection(0, 99);
      useCollectionStore.getState().reorderCollection(0, 0);
      expect(useCollectionStore.getState().collections).toBe(before);
    });
  });

  describe("reorderUngroupedProject", () => {
    it("inserts a project before another ungrouped project", () => {
      const store = useCollectionStore.getState();
      store.reorderUngroupedProject("p1");
      store.reorderUngroupedProject("p2");
      store.reorderUngroupedProject("p3", "p1");

      expect(useCollectionStore.getState().ungroupedProjectIds).toEqual([
        "p3",
        "p1",
        "p2",
      ]);
    });
    it("inserts a project after another ungrouped project", () => {
      const store = useCollectionStore.getState();
      store.reorderUngroupedProject("p1");
      store.reorderUngroupedProject("p2");
      store.reorderUngroupedProject("p3", "p1", undefined, "after");

      expect(useCollectionStore.getState().ungroupedProjectIds).toEqual([
        "p1",
        "p3",
        "p2",
      ]);
    });

    it("keeps untracked projects in their visible order", () => {
      useCollectionStore
        .getState()
        .reorderUngroupedProject("p3", "p2", ["p1", "p2", "p3"]);

      expect(useCollectionStore.getState().ungroupedProjectIds).toEqual([
        "p1",
        "p3",
        "p2",
      ]);
    });
  });

  describe("collapsed state", () => {
    it("toggles and sets explicitly", () => {
      const a = useCollectionStore.getState().createCollection("A");
      useCollectionStore.getState().toggleCollapsed(a.id);
      expect(useCollectionStore.getState().collapsed[a.id]).toBe(true);
      useCollectionStore.getState().setCollapsed(a.id, false);
      expect(useCollectionStore.getState().collapsed[a.id]).toBe(false);
      useCollectionStore.getState().setCollapsed(a.id, true);
      expect(useCollectionStore.getState().collapsed[a.id]).toBe(true);
      // toggle removes the key entirely (falsy absence semantics)
      useCollectionStore.getState().toggleCollapsed(a.id);
      expect(useCollectionStore.getState().collapsed[a.id]).toBeUndefined();
    });
  });

  describe("pruneDeletedProjects", () => {
    it("drops project ids that no longer exist", () => {
      const a = useCollectionStore.getState().createCollection("A");
      useCollectionStore.getState().moveProjectToCollection("p1", a.id);
      useCollectionStore.getState().moveProjectToCollection("p2", a.id);
      useCollectionStore.getState().pruneDeletedProjects(new Set(["p1"]));
      expect(useCollectionStore.getState().collections[0].projectIds).toEqual([
        "p1",
      ]);
    });

    it("does not mutate when all project ids still exist", () => {
      const a = useCollectionStore.getState().createCollection("A");
      useCollectionStore.getState().moveProjectToCollection("p1", a.id);
      const before = useCollectionStore.getState().collections[0];
      useCollectionStore.getState().pruneDeletedProjects(new Set(["p1"]));
      // Same array reference means no rewrite happened.
      expect(useCollectionStore.getState().collections[0]).toBe(before);
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createThrottledJSONStorage } from "./throttledStorage";

interface Payload {
  count: number;
}

const KEY = "throttled-storage-test";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createThrottledJSONStorage", () => {
  it("collapses rapid writes into a single trailing localStorage write", () => {
    const storage = createThrottledJSONStorage<Payload>(300);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    for (let count = 1; count <= 5; count++) {
      storage.setItem(KEY, { state: { count }, version: 1 });
    }
    expect(setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(storage.getItem(KEY)).toEqual({ state: { count: 5 }, version: 1 });
    setItem.mockRestore();
  });

  it("writes immediately when flushed", () => {
    const storage = createThrottledJSONStorage<Payload>(300);
    storage.setItem(KEY, { state: { count: 1 }, version: 1 });

    storage.flush();

    expect(storage.getItem(KEY)).toEqual({ state: { count: 1 }, version: 1 });
  });

  it("drops a pending write when the key is removed", () => {
    const storage = createThrottledJSONStorage<Payload>(300);
    storage.setItem(KEY, { state: { count: 1 }, version: 1 });

    storage.removeItem(KEY);
    vi.advanceTimersByTime(300);

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("reads straight from localStorage so injected values win", () => {
    const storage = createThrottledJSONStorage<Payload>(300);
    storage.setItem(KEY, { state: { count: 1 }, version: 1 });
    localStorage.setItem(KEY, JSON.stringify({ state: { count: 9 } }));

    expect(storage.getItem(KEY)).toEqual({ state: { count: 9 } });
  });

  it("returns null for unparseable stored values", () => {
    localStorage.setItem(KEY, "{not json");
    const storage = createThrottledJSONStorage<Payload>(300);

    expect(storage.getItem(KEY)).toBeNull();
  });
});

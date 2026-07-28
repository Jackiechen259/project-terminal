/**
 * Trailing-debounced `PersistStorage` for zustand.
 *
 * The default `createJSONStorage` serializes and writes localStorage on every
 * `set()`. Layout state changes at pointer-event rate (split drags, font zoom),
 * so wrapping at the `PersistStorage` level defers both the `JSON.stringify`
 * and the synchronous write. A crash can lose up to `delayMs` of UI layout
 * state, which is acceptable: restored tabs are reset to `exited` on rehydrate
 * anyway.
 */

import type { PersistStorage, StorageValue } from "zustand/middleware";

export interface ThrottledJSONStorage<S> extends PersistStorage<S> {
  /** Write any pending value immediately. Exposed for tests and teardown. */
  flush: () => void;
}

export function createThrottledJSONStorage<S>(
  delayMs = 300,
): ThrottledJSONStorage<S> {
  let pending: { name: string; value: StorageValue<S> } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    const { name, value } = pending;
    pending = null;
    try {
      localStorage.setItem(name, JSON.stringify(value));
    } catch {
      // Quota or private-mode failures must not break the app.
    }
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    // WebView2 teardown does not always run the unload handlers; hiding the
    // window does, so this is the reliable path for "app is closing".
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }

  return {
    getItem: (name) => {
      // Deliberately does not flush: `getItem` only runs during hydration,
      // where the in-memory store already holds anything still pending, and
      // flushing here would clobber a value written straight to localStorage.
      const raw = localStorage.getItem(name);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as StorageValue<S>;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      // Zustand snapshots are immutable, so deferring the stringify is safe.
      pending = { name, value };
      if (timer === null) timer = setTimeout(flush, delayMs);
    },
    removeItem: (name) => {
      if (pending?.name === name) pending = null;
      localStorage.removeItem(name);
    },
    flush,
  };
}

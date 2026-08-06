import "@testing-library/jest-dom/vitest";

/**
 * Node 24+ defines `localStorage`/`sessionStorage` on the global object, and
 * without `--localstorage-file` those properties evaluate to `undefined`. In a
 * jsdom test environment the Node property shadows jsdom's own storage, so
 * every persisted-store test sees no storage at all - `localStorage.clear()`
 * throws before the test body even runs.
 *
 * Install a working implementation when that happens, so the suite does not
 * depend on which Node major the developer happens to have installed.
 *
 * The methods go on `Storage.prototype` rather than the instances: tests spy
 * there (`vi.spyOn(Storage.prototype, "setItem")`) to count writes, and an own
 * property would shadow the spy. Each instance keeps its own backing map, so
 * `localStorage` and `sessionStorage` stay independent.
 */
function installStorageFallback() {
  const global = globalThis as Record<string, unknown>;
  const missing = (["localStorage", "sessionStorage"] as const).filter(
    (name) => !global[name],
  );
  if (missing.length === 0 || typeof Storage !== "function") return;

  const backing = new WeakMap<object, Map<string, string>>();
  const entriesOf = (instance: object) => {
    let entries = backing.get(instance);
    if (!entries) {
      entries = new Map();
      backing.set(instance, entries);
    }
    return entries;
  };

  Object.defineProperties(Storage.prototype, {
    length: {
      configurable: true,
      get(this: object) {
        return entriesOf(this).size;
      },
    },
    clear: {
      configurable: true,
      writable: true,
      value(this: object) {
        entriesOf(this).clear();
      },
    },
    getItem: {
      configurable: true,
      writable: true,
      value(this: object, key: string) {
        return entriesOf(this).get(String(key)) ?? null;
      },
    },
    key: {
      configurable: true,
      writable: true,
      value(this: object, index: number) {
        return [...entriesOf(this).keys()][index] ?? null;
      },
    },
    removeItem: {
      configurable: true,
      writable: true,
      value(this: object, key: string) {
        entriesOf(this).delete(String(key));
      },
    },
    setItem: {
      configurable: true,
      writable: true,
      value(this: object, key: string, value: string) {
        entriesOf(this).set(String(key), String(value));
      },
    },
  });

  for (const name of missing) {
    const storage = Object.create(Storage.prototype) as Storage;
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: storage,
    });
    if (typeof window !== "undefined" && window !== globalThis) {
      Object.defineProperty(window, name, {
        configurable: true,
        value: storage,
      });
    }
  }
}

installStorageFallback();

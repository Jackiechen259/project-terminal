import { useCallback, useEffect, useState } from "react";

import { type AppLanguage, useSettingsStore } from "@/stores/settingsStore";

type TranslationParams = Record<string, string | number>;
type Dictionary = Record<string, string>;

/** The `t` function returned by `useTranslation`, for passing between components. */
export type TranslateFn = (
  source: string,
  params?: TranslationParams,
) => string;

// English strings are the source text itself (see `translate` below), so it
// never needs a dictionary or a dynamic import. Every other language is
// fetched on demand: `zh-CN` alone is ~34KB of source that no English
// session should have to download and parse at startup.
const localeLoaders: Partial<
  Record<AppLanguage, () => Promise<{ default: Dictionary }>>
> = {
  "zh-CN": () => import("./locales/zh-CN"),
};

const loadedDictionaries: Partial<Record<AppLanguage, Dictionary>> = {
  en: {},
};
const pendingLoads = new Map<AppLanguage, Promise<void>>();

/**
 * Kick off (and dedupe) a locale's dynamic import. Returns the in-flight
 * promise so a caller can wait for it; returns `undefined` when the
 * dictionary is already loaded (or there is nothing to load, e.g. `en`).
 */
function ensureDictionaryLoaded(
  language: AppLanguage,
): Promise<void> | undefined {
  if (loadedDictionaries[language]) return undefined;
  const pending = pendingLoads.get(language);
  if (pending) return pending;
  const loader = localeLoaders[language];
  if (!loader) {
    loadedDictionaries[language] = {};
    return undefined;
  }
  const promise = loader()
    .then((module) => {
      loadedDictionaries[language] = module.default;
    })
    .finally(() => {
      pendingLoads.delete(language);
    });
  pendingLoads.set(language, promise);
  return promise;
}

/** Wait for a language's dictionary to be available before translating. */
export function preloadLanguage(language: AppLanguage): Promise<void> {
  return ensureDictionaryLoaded(language) ?? Promise.resolve();
}

/**
 * Translate `source` into `language`.
 *
 * Synchronous and best-effort: if the dictionary has not finished loading
 * yet (or the language has no dictionary at all), this returns `source`
 * unchanged and kicks off the load in the background - `useTranslation`
 * below re-renders its caller once that load resolves. `source` is always a
 * literal English string at the call site, so falling back to it never
 * produces a blank or broken label, only a momentarily untranslated one.
 */
export function translate(
  language: AppLanguage,
  source: string,
  params?: TranslationParams,
) {
  void ensureDictionaryLoaded(language);
  const translated = loadedDictionaries[language]?.[source] ?? source;
  if (!params) return translated;
  return translated.replace(/\{(\w+)\}/g, (match, key: string) =>
    params[key] === undefined ? match : String(params[key]),
  );
}

export function useTranslation() {
  const language = useSettingsStore((state) => state.language);
  // Bumped once a dictionary this component needs finishes loading, so `t`
  // starts returning translated strings without requiring every caller to
  // manage its own loading state.
  const [, setLoadedTick] = useState(0);

  useEffect(() => {
    const pending = ensureDictionaryLoaded(language);
    if (!pending) return;
    let cancelled = false;
    void pending.then(() => {
      if (!cancelled) setLoadedTick((tick) => tick + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const t = useCallback(
    (source: string, params?: TranslationParams) =>
      translate(language, source, params),
    [language],
  );
  return { language, t };
}

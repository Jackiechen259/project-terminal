import { lazy, Suspense, useEffect, useLayoutEffect, useState } from "react";

import { AppLayout } from "@/components/layout/AppLayout";
import { usePlatformStore } from "@/stores/platformStore";
import { useSettingsStore } from "@/stores/settingsStore";

const LazyUpdateManager = lazy(() =>
  import("@/components/updates/UpdateManager").then((module) => ({
    default: module.UpdateManager,
  })),
);

export default function App() {
  const loadPlatformInfo = usePlatformStore((s) => s.load);
  const language = useSettingsStore((state) => state.language);
  const theme = useSettingsStore((state) => state.theme);
  const [updaterReady, setUpdaterReady] = useState(false);
  useEffect(() => {
    void loadPlatformInfo();
  }, [loadPlatformInfo]);
  useEffect(() => {
    // Update checks are useful background work, but neither their JavaScript
    // nor their network request belongs on the first-paint critical path.
    const timer = window.setTimeout(() => setUpdaterReady(true), 500);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  useLayoutEffect(() => {
    const nextTheme =
      theme === "eye-care" || theme === "light" ? theme : "dark";
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme =
      nextTheme === "dark" ? "dark" : "light";
  }, [theme]);
  return (
    <>
      <AppLayout />
      {updaterReady ? (
        <Suspense fallback={null}>
          <LazyUpdateManager />
        </Suspense>
      ) : null}
    </>
  );
}

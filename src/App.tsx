import { useEffect, useLayoutEffect } from "react";

import { AppLayout } from "@/components/layout/AppLayout";
import { UpdateManager } from "@/components/updates/UpdateManager";
import { usePlatformStore } from "@/stores/platformStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useDaemonStore } from "@/stores/daemonStore";

export default function App() {
  const loadPlatformInfo = usePlatformStore((s) => s.load);
  const language = useSettingsStore((state) => state.language);
  const theme = useSettingsStore((state) => state.theme);
  const refreshDaemon = useDaemonStore((state) => state.refresh);
  useEffect(() => {
    void loadPlatformInfo();
  }, [loadPlatformInfo]);
  useEffect(() => {
    void refreshDaemon();
    const timer = window.setInterval(() => void refreshDaemon(), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshDaemon]);
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
      <UpdateManager />
    </>
  );
}

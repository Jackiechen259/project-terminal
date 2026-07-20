import { useEffect } from "react";

import { AppLayout } from "@/components/layout/AppLayout";
import { UpdateManager } from "@/components/updates/UpdateManager";
import { usePlatformStore } from "@/stores/platformStore";

export default function App() {
  const loadPlatformInfo = usePlatformStore((s) => s.load);
  useEffect(() => {
    void loadPlatformInfo();
  }, [loadPlatformInfo]);
  return (
    <>
      <AppLayout />
      <UpdateManager />
    </>
  );
}

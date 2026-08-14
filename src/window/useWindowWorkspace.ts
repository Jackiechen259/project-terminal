/**
 * React access to the current workspace's identity.
 *
 * The workspace info is resolved once before rendering (see `windowBoot.ts`)
 * and provided through the context set up by `WindowWorkspaceProvider`.
 * Outside Tauri (browser dev, tests) the fallback is the legacy `main`
 * workspace so the UI still renders.
 */

import { createContext, useContext } from "react";

import { getCurrentWorkspaceId } from "@/stores/terminalStore";
import type { WorkspaceInfo } from "./windowService";

export const WorkspaceContext = createContext<WorkspaceInfo | null>(null);

export function useWindowWorkspace(): WorkspaceInfo {
  const info = useContext(WorkspaceContext);
  if (info) return info;
  const id = getCurrentWorkspaceId();
  return { windowLabel: id, workspaceId: id, projectId: null };
}

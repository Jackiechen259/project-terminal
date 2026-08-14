/**
 * Provides the resolved workspace identity to the React tree.
 *
 * The identity itself is resolved once before rendering (see `windowBoot.ts`);
 * this provider only makes it available through context so components can read
 * it without calling the backend again.
 */

import type { ReactNode } from "react";

import { WorkspaceContext } from "./useWindowWorkspace";
import type { WorkspaceInfo } from "./windowService";

export function WindowWorkspaceProvider({
  info,
  children,
}: {
  info: WorkspaceInfo;
  children: ReactNode;
}) {
  return (
    <WorkspaceContext.Provider value={info}>
      {children}
    </WorkspaceContext.Provider>
  );
}

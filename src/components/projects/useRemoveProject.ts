import { useCallback } from "react";

import { useProjectStore } from "@/stores/projectStore";
import { useMemoStore } from "@/stores/memoStore";
import { useTerminalStore } from "@/stores/terminalStore";

/**
 * Coordinate the frontend state transition around backend-owned project
 * deletion. The backend closes the project's PTYs and deletes its persisted
 * resources; this hook only keeps workspace selection and cached tabs/memos
 * consistent, including rollback when persistence fails.
 */
export function useRemoveProject() {
  const projects = useProjectStore((state) => state.projects);
  const deleteProject = useProjectStore((state) => state.deleteProject);
  const setActiveProject = useTerminalStore((state) => state.setActiveProject);
  const removeProjectTabs = useTerminalStore(
    (state) => state.removeProjectTabs,
  );

  return useCallback(
    async (projectId: string) => {
      let switchedProject = false;
      let nextProjectId: string | null = null;
      if (useTerminalStore.getState().activeProjectId === projectId) {
        nextProjectId =
          projects.find((candidate) => candidate.id !== projectId)?.id ?? null;
        setActiveProject(nextProjectId);
        switchedProject = true;
      }

      try {
        await deleteProject(projectId);
        // Both cleanups run only after the backend delete succeeded, so a
        // failed delete can never lose tabs or memos.
        removeProjectTabs(projectId);
        useMemoStore.getState().removeProjectMemos(projectId);
      } catch (error) {
        if (
          switchedProject &&
          useTerminalStore.getState().activeProjectId === nextProjectId
        ) {
          setActiveProject(projectId);
        }
        throw error;
      }
    },
    [deleteProject, projects, removeProjectTabs, setActiveProject],
  );
}

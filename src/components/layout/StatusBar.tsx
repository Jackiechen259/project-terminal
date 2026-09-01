import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useTranslation } from "@/i18n";
import { workingDirectoryLabel } from "@/lib/terminalShellIntegration";
import { cn } from "@/lib/utils";
import { useProfileStore } from "@/stores/profileStore";
import { useTerminalStore } from "@/stores/terminalStore";

/**
 * A 22px strip along the bottom of the window.
 *
 * It exists because the borderless window had a hairline along its top edge
 * and nothing along its bottom, which read as unfinished; and because the
 * facts it shows - which shell, where it is, how the last command ended -
 * were being carried in state with nowhere to appear. The working directory
 * in particular arrives from OSC 7 and had no consumer at all.
 *
 * Everything here degrades to absent rather than to a placeholder. A profile
 * without shell integration simply shows less.
 */
export function StatusBar() {
  const { t } = useTranslation();
  // Reads the whole tabsById/tabGroupsByProjectId maps internally, but
  // useShallow compares only these four extracted fields - so a title/status
  // change on any tab OTHER than the active one no longer re-renders this
  // component, unlike selecting the maps themselves.
  const { profileId, projectId, cwd, exitCode } = useTerminalStore(
    useShallow((state) => {
      const activeTabId = state.activeProjectId
        ? state.tabGroupsByProjectId[state.activeProjectId]?.activeTabId
        : null;
      const tab = activeTabId ? state.tabsById[activeTabId] : undefined;
      return {
        profileId: tab?.profileId,
        projectId: tab?.projectId,
        cwd: tab?.cwd,
        exitCode: tab?.lastCommandExitCode,
      };
    }),
  );
  const profilesByProject = useProfileStore((state) => state.byProjectId);
  const hasTab = projectId !== undefined;

  const profileName = useMemo(() => {
    if (!projectId || !profileId) return undefined;
    return profilesByProject[projectId]?.find((p) => p.id === profileId)?.name;
  }, [profileId, profilesByProject, projectId]);

  return (
    <footer
      className="flex h-[22px] shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-[11px] text-muted-foreground"
      aria-label={t("Status")}
    >
      {hasTab && profileName ? (
        <span className="shrink-0 truncate">{profileName}</span>
      ) : null}
      {cwd ? (
        // Only ever set by OSC 7, so its presence already means the profile
        // opted into shell integration.
        <span className="min-w-0 truncate" title={cwd}>
          {workingDirectoryLabel(cwd)}
        </span>
      ) : null}
      {hasTab ? <span className="ml-auto shrink-0" /> : null}
      {exitCode !== undefined ? (
        <span
          className={cn("shrink-0", exitCode === 0 ? "text-ok" : "text-danger")}
          title={t("Exit status of the last command")}
        >
          {exitCode === 0 ? "✓" : `✗ ${exitCode}`}
        </span>
      ) : null}
    </footer>
  );
}

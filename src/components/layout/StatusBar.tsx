import { useMemo } from "react";

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
  const activeProjectId = useTerminalStore((state) => state.activeProjectId);
  const tabsById = useTerminalStore((state) => state.tabsById);
  const tabGroups = useTerminalStore((state) => state.tabGroupsByProjectId);
  const profilesByProject = useProfileStore((state) => state.byProjectId);

  const tab = useMemo(() => {
    const activeTabId = activeProjectId
      ? tabGroups[activeProjectId]?.activeTabId
      : null;
    return activeTabId ? tabsById[activeTabId] : undefined;
  }, [activeProjectId, tabGroups, tabsById]);

  const profileName = useMemo(() => {
    if (!tab) return undefined;
    return profilesByProject[tab.projectId]?.find((p) => p.id === tab.profileId)
      ?.name;
  }, [profilesByProject, tab]);

  if (!tab) return null;

  const exitCode = tab.lastCommandExitCode;
  return (
    <footer
      className="flex h-[22px] shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-[11px] text-muted-foreground"
      aria-label={t("Status")}
    >
      {profileName ? (
        <span className="shrink-0 truncate">{profileName}</span>
      ) : null}
      {tab.cwd ? (
        // Only ever set by OSC 7, so its presence already means the profile
        // opted into shell integration.
        <span className="min-w-0 truncate" title={tab.cwd}>
          {workingDirectoryLabel(tab.cwd)}
        </span>
      ) : null}
      <span className="ml-auto shrink-0" />
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

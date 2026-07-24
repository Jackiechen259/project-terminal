import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Boxes,
  Columns2,
  Plus,
  RotateCcw,
  Rows2,
  Settings2,
  Sparkles,
  Square,
  Star,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";

import {
  ContextMenu,
  type ContextMenuItem,
} from "@/components/ui/context-menu";
import { useDragPreviewPosition } from "@/lib/useDragPreviewPosition";
import { joinContextMenuSections } from "@/components/ui/context-menu-items";
import { dispatchAppCommand, listenForAppCommands } from "@/lib/appCommands";
import { getAppShortcut, isBrowserShortcut } from "@/lib/keyboardShortcuts";
import { useTranslation } from "@/i18n";
import {
  BUILT_IN_PROFILE_PRESETS,
  findProfileByName,
  isProfileShownInContextMenu,
  normalizedProfileName,
  uniqueProfilesByName,
} from "@/lib/profilePresets";
import { getProfileTemplateIcon } from "@/lib/profileTemplateIcons";
import {
  environmentService,
  profileService,
  templateService,
  terminalService,
  type ProfileInput,
} from "@/services";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTemplateStore } from "@/stores/templateStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { cn } from "@/lib/utils";
import type {
  ProfileTemplate,
  Project,
  TerminalProfile,
  TerminalSplitDirection,
  TerminalTab,
} from "@/types";

import { TerminalPane } from "./TerminalPane";

type TerminalDropZone = "left" | "right" | "top" | "bottom";
type TabDropPosition = "before" | "after";
type TabDropTarget = { tabId: string; position: TabDropPosition };

/** Detected Conda environment available as a quick-launch target. */
interface CondaEnvOption {
  name: string;
  condaExecutable: string;
}

/**
 * Terminal workspace: tab strip + terminal area.
 *
 * Plan §10/§25.5: render EVERY project's TerminalViews at once. Non-active
 * projects have their containers hidden via CSS `display:none`. Switching
 * projects only changes which container is visible - the PTY readers and
 * xterm instances for other projects keep running. This is the core
 * invariant: project switching must NOT close sessions or dispose xterm.
 *
 * The workspace creates/closes backend sessions. Each TerminalView only
 * attaches to its existing session and detaches when React disposes it.
 */
export function TerminalWorkspace() {
  const { t } = useTranslation();
  const activeProjectId = useTerminalStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const tabsById = useTerminalStore((s) => s.tabsById);
  const tabGroups = useTerminalStore((s) => s.tabGroupsByProjectId);
  const splitViews = useTerminalStore((s) => s.splitViewsByProjectId);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const setSplitView = useTerminalStore((s) => s.setSplitView);
  const replaceSplitTab = useTerminalStore((s) => s.replaceSplitTab);
  const clearSplitView = useTerminalStore((s) => s.clearSplitView);
  const reorderTab = useTerminalStore((s) => s.reorderTab);
  const registerTab = useTerminalStore((s) => s.registerTab);
  const removeTab = useTerminalStore((s) => s.removeTab);
  const updateTab = useTerminalStore((s) => s.updateTab);
  const confirmCloseTerminal = useSettingsStore((s) => s.confirmCloseTerminal);
  const templateList = useTemplateStore((s) => s.templates);
  const templatesLoaded = useTemplateStore((s) => s.loaded);
  const loadTemplates = useTemplateStore((s) => s.loadTemplates);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [activePaneIndex, setActivePaneIndex] = useState<0 | 1>(0);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropZone, setDropZone] = useState<TerminalDropZone | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<TabDropTarget | null>(
    null,
  );
  const [menuPosition, setMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [plusMenuPosition, setPlusMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [condaEnvs, setCondaEnvs] = useState<CondaEnvOption[]>([]);
  const tabListRef = useRef<HTMLDivElement>(null);
  const splitTabGroupRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const pointerDragRef = useRef<{
    tabId: string;
    pointerId: number;
    startX: number;
    startY: number;
    started: boolean;
  } | null>(null);
  const dropZoneRef = useRef<TerminalDropZone | null>(null);
  const tabDropTargetRef = useRef<TabDropTarget | null>(null);
  const suppressTabClickRef = useRef(false);
  const { previewRef, updatePreviewPosition, resetPreviewPosition } =
    useDragPreviewPosition();

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const selectedProfile = profiles.find(
    (profile) => profile.id === selectedProfileId,
  );
  const contextMenuProfiles = useMemo(
    () => uniqueProfilesByName(profiles.filter(isProfileShownInContextMenu)),
    [profiles],
  );
  const applyProfiles = useCallback((nextProfiles: TerminalProfile[]) => {
    setProfiles(nextProfiles);
    setSelectedProfileId((current) =>
      nextProfiles.some((profile) => profile.id === current)
        ? current
        : (nextProfiles.find((profile) => profile.isDefault)?.id ??
          nextProfiles[0]?.id ??
          ""),
    );
  }, []);
  const group = activeProjectId ? tabGroups[activeProjectId] : undefined;
  const tabIds = useMemo(() => group?.tabIds ?? [], [group]);
  const activeTabId = group?.activeTabId ?? null;
  const splitView = activeProjectId ? splitViews[activeProjectId] : undefined;
  const validSplitView =
    splitView &&
    splitView.tabIds[0] !== splitView.tabIds[1] &&
    splitView.tabIds.every((id) => tabIds.includes(id))
      ? splitView
      : undefined;

  useEffect(() => {
    setActivePaneIndex(0);
  }, [activeProjectId]);

  useEffect(() => {
    if (!activeTabId) return;
    tabListRef.current
      ?.querySelector<HTMLElement>("[data-active='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  const handleNewTerminal = useCallback(
    async (projectId: string, preferredProfileId?: string) => {
      setError(null);
      try {
        // The active project's profiles are already loaded for the selector.
        // Reuse them so opening a tab does not wait on another IPC + disk read.
        const availableProfiles =
          projectId === activeProjectId && profiles.length > 0
            ? profiles
            : await profileService.list(projectId);
        if (availableProfiles.length === 0) {
          setError(t("This project has no terminal profiles yet."));
          return null;
        }
        const profile =
          availableProfiles.find((p) => p.id === preferredProfileId) ??
          availableProfiles.find((p) => p.isDefault) ??
          availableProfiles[0];
        const sessionId = await terminalService.create({
          projectId,
          profileId: profile.id,
          rows: 24,
          cols: 80,
        });
        const tab: TerminalTab = {
          id: crypto.randomUUID(),
          sessionId,
          projectId,
          profileId: profile.id,
          defaultTitle: profile.name,
          title: profile.name,
          cwd: "",
          status: "running",
          createdAt: Date.now(),
          lastActivatedAt: Date.now(),
        };
        registerTab(tab);
        return tab.id;
      } catch (e) {
        const err = e as { message?: string };
        setError(err.message ?? t("Failed to start terminal"));
        return null;
      }
    },
    [activeProjectId, profiles, registerTab, t],
  );

  const handleSplitTerminal = useCallback(
    async (direction: TerminalSplitDirection) => {
      if (!activeProjectId) return;
      const sourceTabId =
        validSplitView?.tabIds[activePaneIndex] ?? activeTabId;
      if (!sourceTabId) return;

      const newTabId = await handleNewTerminal(
        activeProjectId,
        selectedProfileId,
      );
      if (!newTabId) return;
      setSplitView(activeProjectId, [sourceTabId, newTabId], direction);
      setActivePaneIndex(1);
      setActiveTab(activeProjectId, newTabId);
    },
    [
      activePaneIndex,
      activeProjectId,
      activeTabId,
      handleNewTerminal,
      selectedProfileId,
      setActiveTab,
      setSplitView,
      validSplitView,
    ],
  );

  const handleSelectTab = useCallback(
    (tabId: string) => {
      if (!activeProjectId) return;
      if (validSplitView) {
        const paneIndex = validSplitView.tabIds.indexOf(tabId);
        if (paneIndex === 0 || paneIndex === 1) {
          setActivePaneIndex(paneIndex);
        } else {
          replaceSplitTab(activeProjectId, activePaneIndex, tabId);
        }
      }
      setActiveTab(activeProjectId, tabId);
    },
    [
      activePaneIndex,
      activeProjectId,
      replaceSplitTab,
      setActiveTab,
      validSplitView,
    ],
  );

  const finishTabDrag = useCallback(() => {
    pointerDragRef.current = null;
    dropZoneRef.current = null;
    tabDropTargetRef.current = null;
    setDraggedTabId(null);
    resetPreviewPosition();
    setDropZone(null);
    setTabDropTarget(null);
  }, [resetPreviewPosition]);

  const getDropAnchorTabId = useCallback(
    (sourceTabId: string) => {
      const focusedTabId =
        validSplitView?.tabIds[activePaneIndex] ?? activeTabId;
      if (focusedTabId && focusedTabId !== sourceTabId) return focusedTabId;
      return tabIds.find((tabId) => tabId !== sourceTabId) ?? null;
    },
    [activePaneIndex, activeTabId, tabIds, validSplitView],
  );

  const canSplitWithTab = useCallback(
    (sourceTabId: string | null) =>
      Boolean(
        sourceTabId &&
        activeProjectId &&
        tabsById[sourceTabId]?.projectId === activeProjectId &&
        getDropAnchorTabId(sourceTabId),
      ),
    [activeProjectId, getDropAnchorTabId, tabsById],
  );

  const getPointerDropZone = useCallback(
    (clientX: number, clientY: number): TerminalDropZone | null => {
      const rect = workspaceRef.current?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return null;
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return null;
      }
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const horizontalEdge = Math.min(x, rect.width - x) / rect.width;
      const verticalEdge = Math.min(y, rect.height - y) / rect.height;
      return horizontalEdge < verticalEdge
        ? x < rect.width / 2
          ? "left"
          : "right"
        : y < rect.height / 2
          ? "top"
          : "bottom";
    },
    [],
  );

  const updateTabDropTarget = useCallback(
    (sourceTabId: string, clientX: number, clientY: number) => {
      let targetElement = document
        .elementFromPoint(clientX, clientY)
        ?.closest<HTMLElement>("[data-terminal-tab-id]");
      let targetTabId = targetElement?.dataset.terminalTabId;
      let position: TabDropPosition | null = null;

      // The empty stretch to the right of the final tab is deliberately a
      // generous "append" zone. Without this, users have to hit the narrow
      // right half of the last tab to move something to the end.
      const lastTabId = tabIds.at(-1);
      const tabListRect = tabListRef.current?.getBoundingClientRect();
      const lastTabElement = lastTabId
        ? Array.from(
            tabListRef.current?.querySelectorAll<HTMLElement>(
              "[data-terminal-tab-id]",
            ) ?? [],
          ).find((element) => element.dataset.terminalTabId === lastTabId)
        : undefined;
      const lastTabRect = lastTabElement?.getBoundingClientRect();
      if (
        lastTabId &&
        tabListRect &&
        lastTabRect &&
        clientX >= lastTabRect.right &&
        clientX <= tabListRect.right &&
        clientY >= tabListRect.top &&
        clientY <= tabListRect.bottom
      ) {
        targetElement = lastTabElement;
        targetTabId = lastTabId;
        position = "after";
      }
      if (!targetElement || !targetTabId || targetTabId === sourceTabId) {
        if (tabDropTargetRef.current) {
          tabDropTargetRef.current = null;
          setTabDropTarget(null);
        }
        return;
      }
      const rect = targetElement.getBoundingClientRect();
      const nextTarget: TabDropTarget = {
        tabId: targetTabId,
        position:
          position ??
          (clientX - rect.left < rect.width / 2 ? "before" : "after"),
      };
      if (
        tabDropTargetRef.current?.tabId === nextTarget.tabId &&
        tabDropTargetRef.current.position === nextTarget.position
      ) {
        return;
      }
      tabDropTargetRef.current = nextTarget;
      setTabDropTarget(nextTarget);
    },
    [tabIds],
  );

  const handleTabPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, tabId: string) => {
      if (
        event.button !== 0 ||
        (event.target instanceof Element &&
          event.target.closest("[data-tab-action]"))
      ) {
        return;
      }
      pointerDragRef.current = {
        tabId,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        started: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const handleTabPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = pointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.started) {
        const moved = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (moved < 6 || !canSplitWithTab(drag.tabId)) return;
        drag.started = true;
        updatePreviewPosition(event.clientX, event.clientY);
        setDraggedTabId(drag.tabId);
      }

      updatePreviewPosition(event.clientX, event.clientY);
      updateTabDropTarget(drag.tabId, event.clientX, event.clientY);
      const nextDropZone = getPointerDropZone(event.clientX, event.clientY);
      dropZoneRef.current = nextDropZone;
      setDropZone(nextDropZone);
      event.preventDefault();
    },
    [
      canSplitWithTab,
      getPointerDropZone,
      updatePreviewPosition,
      updateTabDropTarget,
    ],
  );

  const handleTabPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = pointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!drag.started) {
        finishTabDrag();
        return;
      }

      suppressTabClickRef.current = true;
      const sourceTabId = drag.tabId;
      const anchorTabId = getDropAnchorTabId(sourceTabId);
      const targetDropZone = dropZoneRef.current;
      const targetTabDrop = tabDropTargetRef.current;
      const tabListRect = tabListRef.current?.getBoundingClientRect();
      const splitGroupRect = splitTabGroupRef.current?.getBoundingClientRect();
      const releasedInTabList =
        tabListRect &&
        event.clientX >= tabListRect.left &&
        event.clientX <= tabListRect.right &&
        event.clientY >= tabListRect.top &&
        event.clientY <= tabListRect.bottom;
      const releasedInSplitGroup =
        splitGroupRect &&
        event.clientX >= splitGroupRect.left &&
        event.clientX <= splitGroupRect.right &&
        event.clientY >= splitGroupRect.top &&
        event.clientY <= splitGroupRect.bottom;
      if (activeProjectId && targetTabDrop) {
        if (validSplitView?.tabIds.includes(sourceTabId)) {
          clearSplitView(activeProjectId);
        }
        reorderTab(
          activeProjectId,
          sourceTabId,
          targetTabDrop.tabId,
          targetTabDrop.position,
        );
        setActiveTab(activeProjectId, sourceTabId);
      } else if (
        activeProjectId &&
        anchorTabId &&
        targetDropZone &&
        canSplitWithTab(sourceTabId)
      ) {
        const sourceFirst =
          targetDropZone === "left" || targetDropZone === "top";
        const tabPair: [string, string] = sourceFirst
          ? [sourceTabId, anchorTabId]
          : [anchorTabId, sourceTabId];
        const direction: TerminalSplitDirection =
          targetDropZone === "left" || targetDropZone === "right"
            ? "side-by-side"
            : "stacked";
        setSplitView(activeProjectId, tabPair, direction);
        setActivePaneIndex(sourceFirst ? 0 : 1);
        setActiveTab(activeProjectId, sourceTabId);
      } else if (
        activeProjectId &&
        validSplitView?.tabIds.includes(sourceTabId) &&
        releasedInTabList &&
        !releasedInSplitGroup
      ) {
        // A grouped tab dragged back into the normal tab strip dissolves the
        // split. Both sessions remain open as ordinary tabs.
        clearSplitView(activeProjectId);
        setActiveTab(activeProjectId, sourceTabId);
      }
      finishTabDrag();
    },
    [
      activeProjectId,
      canSplitWithTab,
      clearSplitView,
      finishTabDrag,
      getDropAnchorTabId,
      setActiveTab,
      setSplitView,
      reorderTab,
      validSplitView,
    ],
  );

  const handleTabPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = pointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      finishTabDrag();
    },
    [finishTabDrag],
  );

  const handleTabClick = useCallback(
    (tabId: string) => {
      if (suppressTabClickRef.current) {
        suppressTabClickRef.current = false;
        return;
      }
      handleSelectTab(tabId);
    },
    [handleSelectTab],
  );

  useEffect(() => {
    if (!activeProjectId) {
      setProfiles([]);
      setSelectedProfileId("");
      return;
    }
    let cancelled = false;
    void profileService
      .list(activeProjectId)
      .then((nextProfiles) => {
        if (cancelled) return;
        applyProfiles(nextProfiles);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(
            (cause as { message?: string }).message ??
              t("Failed to load terminal profiles"),
          );
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, applyProfiles, t]);

  // Detect Conda environments for quick-launch in the + button menu. Only
  // runs for local/WSL projects where a Conda install is reachable from the
  // host. SSH remotes are skipped (their Conda lives on the remote host).
  useEffect(() => {
    if (!activeProjectId || !activeProject || activeProject.type === "ssh") {
      setCondaEnvs([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const condaPaths = await environmentService.detectConda();
        if (condaPaths.length === 0 || cancelled) {
          if (!cancelled) setCondaEnvs([]);
          return;
        }
        const condaExecutable = condaPaths[0];
        const envs = await environmentService.listConda(condaExecutable);
        if (cancelled) return;
        setCondaEnvs(
          envs
            .filter((env) => !env.isBase)
            .map((env) => ({
              name: env.name ?? env.path,
              condaExecutable,
            })),
        );
      } catch {
        if (!cancelled) setCondaEnvs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProjectId, activeProject]);

  // Load global profile templates for the + quick-launch menu.
  useEffect(() => {
    if (!templatesLoaded) void loadTemplates();
  }, [templatesLoaded, loadTemplates]);

  // Quick-launch a terminal from a preset template. Creates the profile on
  // first use (by name), then reuses the existing one on subsequent launches.
  const handleQuickLaunch = useCallback(
    async (
      presetName: string,
      configure: (base: ProfileInput) => void,
    ): Promise<string | null> => {
      if (!activeProjectId) return null;
      setError(null);
      try {
        const existing = findProfileByName(profiles, presetName);
        let profile: TerminalProfile;
        if (existing) {
          profile = existing;
        } else {
          const project = projects.find((p) => p.id === activeProjectId) as
            Project | undefined;
          const base: ProfileInput = {
            projectId: activeProjectId,
            name: presetName,
            shellType:
              project?.type === "ssh" ? "remote-default" : "powershell",
            environmentType: "none",
            isDefault: false,
            showInContextMenu: true,
          };
          configure(base);
          profile = await profileService.create(base);
          setProfiles((prev) => [...prev, profile]);
        }
        const sessionId = await terminalService.create({
          projectId: activeProjectId,
          profileId: profile.id,
          rows: 24,
          cols: 80,
        });
        const tab: TerminalTab = {
          id: crypto.randomUUID(),
          sessionId,
          projectId: activeProjectId,
          profileId: profile.id,
          defaultTitle: profile.name,
          title: profile.name,
          cwd: "",
          status: "running",
          createdAt: Date.now(),
          lastActivatedAt: Date.now(),
        };
        registerTab(tab);
        return tab.id;
      } catch (e) {
        const err = e as { message?: string };
        setError(err.message ?? t("Failed to launch preset terminal"));
        return null;
      }
    },
    [activeProjectId, profiles, projects, registerTab, t],
  );

  // Quick-launch from a saved template. Reuse a same-name project profile so
  // repeated launches do not accumulate duplicate profiles.
  const handleLaunchFromTemplate = useCallback(
    async (template: ProfileTemplate): Promise<string | null> => {
      if (!activeProjectId) return null;
      setError(null);
      try {
        const existing = findProfileByName(profiles, template.name);
        const profile =
          existing ??
          (await templateService.createFromTemplate(
            template.id,
            activeProjectId,
            template.name,
          ));
        if (!existing) setProfiles((prev) => [...prev, profile]);
        const sessionId = await terminalService.create({
          projectId: activeProjectId,
          profileId: profile.id,
          rows: 24,
          cols: 80,
        });
        const tab: TerminalTab = {
          id: crypto.randomUUID(),
          sessionId,
          projectId: activeProjectId,
          profileId: profile.id,
          defaultTitle: profile.name,
          title: profile.name,
          cwd: "",
          status: "running",
          createdAt: Date.now(),
          lastActivatedAt: Date.now(),
        };
        registerTab(tab);
        return tab.id;
      } catch (e) {
        const err = e as { message?: string };
        setError(err.message ?? t("Failed to launch from template"));
        return null;
      }
    },
    [activeProjectId, profiles, registerTab, t],
  );

  async function handleRestart(tabId: string) {
    const oldTab = tabsById[tabId];
    if (!oldTab) return;
    setError(null);
    updateTab(tabId, { status: "starting", exitCode: undefined });
    try {
      const sessionId = await terminalService.restart(oldTab.sessionId);
      updateTab(tabId, {
        sessionId,
        status: "running",
        exitCode: undefined,
      });
    } catch (e) {
      const err = e as { message?: string };
      updateTab(tabId, { status: "error" });
      setError(err.message ?? t("Failed to start terminal"));
    }
  }

  const handleCloseTab = useCallback(
    async (tabId: string) => {
      const tab = tabsById[tabId];
      const isRunning =
        tab &&
        ["starting", "connecting", "initializing", "running"].includes(
          tab.status,
        );
      if (
        confirmCloseTerminal &&
        isRunning &&
        !window.confirm(
          t('Close the running terminal "{name}"?', {
            name: tab?.title ?? t("Terminal"),
          }),
        )
      ) {
        return;
      }
      if (!tab) return;
      try {
        await terminalService.close(tab.sessionId);
        removeTab(tabId);
      } catch (e) {
        const err = e as { message?: string };
        setError(err.message ?? t("Failed to close terminal"));
      }
    },
    [confirmCloseTerminal, removeTab, t, tabsById],
  );

  const handleCloseSplitGroup = useCallback(async () => {
    if (!validSplitView) return;
    const groupTabs = validSplitView.tabIds
      .map((tabId) => tabsById[tabId])
      .filter((tab): tab is TerminalTab => Boolean(tab));
    const hasRunningTerminal = groupTabs.some((tab) =>
      ["starting", "connecting", "initializing", "running"].includes(
        tab.status,
      ),
    );
    if (
      confirmCloseTerminal &&
      hasRunningTerminal &&
      !window.confirm(t("Close both terminals in this split group?"))
    ) {
      return;
    }
    try {
      await Promise.all(
        groupTabs.map((tab) => terminalService.close(tab.sessionId)),
      );
      groupTabs.forEach((tab) => removeTab(tab.id));
    } catch (e) {
      const err = e as { message?: string };
      setError(err.message ?? t("Failed to close terminal"));
    }
  }, [confirmCloseTerminal, removeTab, t, tabsById, validSplitView]);

  const selectRelativeTab = useCallback(
    (direction: 1 | -1) => {
      if (!activeProjectId || tabIds.length < 2 || !activeTabId) return;
      const currentIndex = tabIds.indexOf(activeTabId);
      const nextIndex =
        (currentIndex + direction + tabIds.length) % tabIds.length;
      handleSelectTab(tabIds[nextIndex]);
    },
    [activeProjectId, activeTabId, handleSelectTab, tabIds],
  );

  useEffect(() => {
    return listenForAppCommands((command) => {
      if (command.type === "new-terminal") {
        void handleNewTerminal(command.projectId);
      } else if (
        command.type === "profiles-changed" &&
        command.projectId === activeProjectId
      ) {
        void profileService
          .list(command.projectId)
          .then(applyProfiles)
          .catch((cause) =>
            setError(
              (cause as { message?: string }).message ??
                t("Failed to refresh terminal profiles"),
            ),
          );
      }
    });
  }, [activeProjectId, applyProfiles, handleNewTerminal, t]);

  useEffect(() => {
    const isEditableControl = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      if (target.closest(".xterm")) return false;
      return Boolean(
        target.closest(
          "input, textarea, select, [contenteditable='true'], [role='dialog']",
        ),
      );
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isBrowserShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (isEditableControl(event.target)) return;

      const shortcut = getAppShortcut(event);
      if (!shortcut) return;

      event.preventDefault();
      event.stopPropagation();
      switch (shortcut.type) {
        case "new-terminal":
          if (activeProjectId) void handleNewTerminal(activeProjectId);
          break;
        case "close-terminal":
          if (activeTabId) void handleCloseTab(activeTabId);
          break;
        case "next-tab":
          selectRelativeTab(1);
          break;
        case "previous-tab":
          selectRelativeTab(-1);
          break;
        case "select-tab": {
          const tabId = tabIds[shortcut.index];
          if (activeProjectId && tabId) handleSelectTab(tabId);
          break;
        }
        case "copy-terminal":
          dispatchAppCommand({ type: "copy-terminal" });
          break;
      }
    };

    // Capture phase ensures these commands win over WebView2's Edge-style
    // browser accelerators, including while xterm's hidden textarea is focused.
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [
    activeProjectId,
    activeTabId,
    tabIds,
    handleCloseTab,
    handleNewTerminal,
    handleSelectTab,
    selectRelativeTab,
  ]);

  const hasAnyTab = Object.keys(tabsById).length > 0;
  const selectTerminalPaneRef = useRef(handleSelectTab);
  selectTerminalPaneRef.current = handleSelectTab;
  const selectTerminalPane = useCallback(
    (tabId: string) => selectTerminalPaneRef.current(tabId),
    [],
  );

  const renderTerminalTab = (id: string) => {
    const tab = tabsById[id];
    if (!tab) return null;
    return (
      <button
        key={id}
        type="button"
        role="tab"
        data-terminal-tab-id={id}
        aria-selected={id === activeTabId}
        data-active={id === activeTabId}
        data-dragging={id === draggedTabId}
        onClick={() => handleTabClick(id)}
        onPointerDown={(event) => handleTabPointerDown(event, id)}
        onPointerMove={handleTabPointerMove}
        onPointerUp={handleTabPointerUp}
        onPointerCancel={handleTabPointerCancel}
        className={cn(
          "group relative flex shrink-0 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground data-[dragging=true]:opacity-50",
          id === activeTabId && "bg-accent text-accent-foreground",
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          handleSelectTab(id);
          setMenuPosition({ x: event.clientX, y: event.clientY });
        }}
      >
        {tabDropTarget?.tabId === id ? (
          <span
            className={cn(
              "pointer-events-none absolute bottom-1 top-1 z-10 w-0.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]",
              tabDropTarget.position === "before" ? "-left-1" : "-right-1",
            )}
          />
        ) : null}
        <div className="flex flex-col items-start">
          <span className="max-w-[160px] truncate">{tab.title}</span>
          {tab.status === "exited" || tab.status === "error" ? (
            <span className="text-[10px] text-danger">
              {tab.status === "error"
                ? t("Connection error")
                : t("Exited ({code})", { code: tab.exitCode ?? "?" })}
            </span>
          ) : null}
        </div>
        {tab.status === "exited" || tab.status === "error" ? (
          <span
            role="button"
            tabIndex={0}
            data-tab-action
            onClick={(event) => {
              event.stopPropagation();
              void handleRestart(id);
            }}
            className="opacity-50 hover:opacity-100"
            aria-label={
              projects.find((project) => project.id === tab.projectId)?.type ===
              "ssh"
                ? t("Reconnect SSH terminal")
                : t("Restart tab")
            }
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <span
          role="button"
          tabIndex={0}
          data-tab-action
          onClick={(event) => {
            event.stopPropagation();
            void handleCloseTab(id);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.stopPropagation();
              void handleCloseTab(id);
            }
          }}
          className="opacity-50 hover:opacity-100"
          aria-label={t("Close tab")}
        >
          <X className="h-3.5 w-3.5" />
        </span>
      </button>
    );
  };

  const profileMenuItems: ContextMenuItem[] = contextMenuProfiles.map(
    (profile) => {
      const sourceTemplate = findProfileByName(templateList, profile.name);
      return {
        label: profile.name,
        icon: sourceTemplate
          ? getProfileTemplateIcon(sourceTemplate.icon)
          : profile.isDefault
            ? Star
            : TerminalIcon,
        onSelect: () => {
          if (activeProjectId)
            void handleNewTerminal(activeProjectId, profile.id);
        },
      };
    },
  );

  // Quick-launch sources are ordered by priority and claimed by normalized
  // name. A materialized profile wins over templates, built-ins and Conda;
  // saved templates then win over same-name built-ins so customizations apply.
  const claimedQuickLaunchNames = new Set(
    profiles.map((profile) => normalizedProfileName(profile.name)),
  );
  const quickLaunchItems: ContextMenuItem[] = [];
  const addQuickLaunchItem = (name: string, item: ContextMenuItem) => {
    const key = normalizedProfileName(name);
    if (claimedQuickLaunchNames.has(key)) return;
    claimedQuickLaunchNames.add(key);
    quickLaunchItems.push(item);
  };

  for (const template of templateList) {
    addQuickLaunchItem(template.name, {
      label: template.name,
      icon: getProfileTemplateIcon(template.icon),
      onSelect: () => void handleLaunchFromTemplate(template),
    });
  }
  for (const preset of BUILT_IN_PROFILE_PRESETS) {
    addQuickLaunchItem(preset.name, {
      label: preset.name,
      icon: Sparkles,
      onSelect: () =>
        void handleQuickLaunch(preset.name, (base) => {
          base.startupCommands = [...preset.startupCommands];
        }),
    });
  }
  for (const env of condaEnvs) {
    const name = `Conda: ${env.name}`;
    addQuickLaunchItem(name, {
      label: name,
      icon: Boxes,
      onSelect: () =>
        void handleQuickLaunch(name, (base) => {
          base.environmentType = "conda";
          base.conda = {
            condaExecutable: env.condaExecutable,
            environmentName: env.name,
            activationMode: "shell-hook",
            autoActivate: true,
          };
        }),
    });
  }

  const plusMenuItems = joinContextMenuSections(
    profileMenuItems,
    quickLaunchItems,
    [
      {
        label: t("Manage profiles…"),
        icon: Settings2,
        onSelect: () =>
          dispatchAppCommand({
            type: "open-settings",
            section: "profiles",
          }),
      },
    ],
  );

  return (
    <section
      className="flex min-w-0 flex-1 flex-col"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      {draggedTabId && tabsById[draggedTabId] ? (
        <div
          ref={previewRef}
          aria-hidden="true"
          className="pointer-events-none fixed left-0 top-0 z-[60] flex max-w-56 will-change-transform items-center gap-2 rounded-md border border-primary/70 bg-surface/80 px-3 py-2 text-xs text-foreground opacity-80 shadow-xl shadow-black/40 backdrop-blur-sm"
        >
          <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate">{tabsById[draggedTabId].title}</span>
        </div>
      ) : null}
      <div className="flex h-11 min-w-0 items-center gap-1 border-b border-border bg-surface px-2">
        <div
          ref={tabListRef}
          role="tablist"
          aria-label={t("Terminal tabs")}
          className="app-scrollbar terminal-tab-scrollbar flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden"
          onWheel={(event) => {
            const tabList = event.currentTarget;
            if (
              tabList.scrollWidth > tabList.clientWidth &&
              Math.abs(event.deltaY) > Math.abs(event.deltaX)
            ) {
              tabList.scrollLeft += event.deltaY;
              event.preventDefault();
            }
          }}
        >
          {tabIds.length === 0 ? (
            <span className="shrink-0 px-2 text-xs text-muted-foreground">
              {activeProject ? t("No terminals open") : t("Select a project")}
            </span>
          ) : (
            <>
              {validSplitView ? (
                <div
                  ref={splitTabGroupRef}
                  role="group"
                  aria-label={t("Split terminal group")}
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-primary/60 bg-accent/40 p-1 shadow-sm"
                >
                  <span className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("Split")}
                  </span>
                  {validSplitView.tabIds.map(renderTerminalTab)}
                  <button
                    type="button"
                    className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                    aria-label={t("Close split group")}
                    title={t("Close both terminals")}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleCloseSplitGroup();
                    }}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : null}
              {tabIds
                .filter((id) => !validSplitView?.tabIds.includes(id))
                .map(renderTerminalTab)}
            </>
          )}
        </div>
        {activeProject && profiles.length > 1 ? (
          <Select
            value={selectedProfileId}
            onValueChange={setSelectedProfileId}
          >
            <SelectTrigger
              aria-label={t("Terminal profile")}
              title={t("Profile used by the + button")}
              className="group h-7 w-36 shrink-0 gap-1.5 rounded-md border-border/70 bg-background/70 px-2 text-xs font-medium shadow-sm transition-all hover:border-primary/40 hover:bg-accent/50 focus:ring-1 focus:ring-primary/50 focus:ring-offset-0 [&>svg:last-child]:h-3.5 [&>svg:last-child]:w-3.5 [&>svg:last-child]:transition-transform data-[state=open]:border-primary/50 data-[state=open]:bg-accent/60 data-[state=open]:[&>svg:last-child]:rotate-180"
            >
              {selectedProfile?.isDefault ? (
                <Star className="h-3.5 w-3.5 shrink-0 fill-primary/20 text-primary" />
              ) : (
                <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
              )}
              <SelectValue placeholder={t("Choose profile")}>
                <span className="block truncate">
                  {selectedProfile?.name ?? t("Choose profile")}
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              align="end"
              sideOffset={6}
              className="min-w-44 rounded-lg border-border/80 bg-popover/95 shadow-xl backdrop-blur-md"
            >
              {profiles.map((profile) => (
                <SelectItem
                  key={profile.id}
                  value={profile.id}
                  textValue={profile.name}
                  className="my-0.5 rounded-md py-1.5 pl-8 pr-2 text-xs focus:bg-accent/80"
                >
                  <span className="block truncate">{profile.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {validSplitView ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("Exit split view")}
            title={t("Exit split view")}
            className="h-7 w-7 text-muted-foreground"
            onClick={() => activeProjectId && clearSplitView(activeProjectId)}
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("New terminal")}
          title={t("New terminal (right-click for presets)")}
          className="h-7 w-7 text-muted-foreground"
          disabled={!activeProject}
          onClick={() =>
            activeProject &&
            void handleNewTerminal(activeProject.id, selectedProfileId)
          }
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (activeProject) {
              setPlusMenuPosition({
                x: event.clientX,
                y: event.clientY,
              });
            }
          }}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div ref={workspaceRef} className="relative flex-1 bg-background">
        {draggedTabId && dropZone ? (
          <div
            className={cn(
              "pointer-events-none absolute z-30 flex items-center justify-center rounded-md border-2 border-primary bg-primary/10 text-xs font-medium text-primary backdrop-blur-[1px] transition-all duration-150 ease-out",
              dropZone === "left" &&
                "bottom-2 left-2 top-2 w-[calc(50%-0.5rem)]",
              dropZone === "right" &&
                "bottom-2 right-2 top-2 w-[calc(50%-0.5rem)]",
              dropZone === "top" && "left-2 right-2 top-2 h-[calc(50%-0.5rem)]",
              dropZone === "bottom" &&
                "bottom-2 left-2 right-2 h-[calc(50%-0.5rem)]",
            )}
          >
            {t("Drop to split {zone}", { zone: t(dropZone) })}
          </div>
        ) : null}
        {activeProject && hasAnyTab ? (
          <>
            {error ? (
              <div className="absolute left-2 top-2 z-10 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
            {/*
              Every TerminalView stays in this same keyed list. Only its CSS
              bounds change when entering or leaving a split, so a layout
              change never disposes/recreates an xterm instance or its PTY.
            */}
            {Object.values(tabsById).map((tab) => {
              const paneIndex = validSplitView?.tabIds.indexOf(tab.id) ?? -1;
              const isSplitPane =
                tab.projectId === activeProjectId && paneIndex !== -1;
              const visible = isSplitPane || tab.id === activeTabId;
              const panePosition =
                paneIndex === 0
                  ? validSplitView?.direction === "side-by-side"
                    ? "left-0 top-0 h-full w-1/2"
                    : "left-0 right-0 top-0 h-1/2"
                  : paneIndex === 1
                    ? validSplitView?.direction === "side-by-side"
                      ? "right-0 top-0 h-full w-1/2 border-l border-border"
                      : "bottom-0 left-0 right-0 h-1/2 border-t border-border"
                    : "inset-0";
              return (
                <TerminalPane
                  key={tab.id}
                  tabId={tab.id}
                  visible={visible}
                  focused={
                    isSplitPane
                      ? activePaneIndex === paneIndex
                      : tab.id === activeTabId
                  }
                  panePosition={panePosition}
                  onSelect={selectTerminalPane}
                />
              );
            })}
          </>
        ) : activeProject ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <TerminalIcon className="mr-2 h-4 w-4" />
            {error ??
              t("No terminals open for {name}.", { name: activeProject.name })}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("Select or create a project to start a terminal.")}
          </div>
        )}
      </div>
      {menuPosition ? (
        <ContextMenu
          position={menuPosition}
          onClose={() => setMenuPosition(null)}
          items={[
            {
              label: t("New terminal"),
              shortcut: "Ctrl+Shift+T",
              icon: Plus,
              disabled: !activeProject,
              onSelect: () =>
                activeProject && void handleNewTerminal(activeProject.id),
            },
            {
              label: t("Split terminal side by side"),
              icon: Columns2,
              disabled: !activeProject || !activeTabId,
              onSelect: () => void handleSplitTerminal("side-by-side"),
            },
            {
              label: t("Split terminal top and bottom"),
              icon: Rows2,
              disabled: !activeProject || !activeTabId,
              onSelect: () => void handleSplitTerminal("stacked"),
            },
            ...(validSplitView
              ? [
                  {
                    label: t("Exit split view"),
                    icon: Square,
                    onSelect: () =>
                      activeProjectId && clearSplitView(activeProjectId),
                  },
                ]
              : []),
            {
              label: t("Close active terminal"),
              shortcut: "Ctrl+Shift+W",
              icon: X,
              disabled: !activeTabId,
              onSelect: () => activeTabId && void handleCloseTab(activeTabId),
            },
          ]}
        />
      ) : null}
      {plusMenuPosition ? (
        <ContextMenu
          position={plusMenuPosition}
          onClose={() => setPlusMenuPosition(null)}
          items={plusMenuItems}
        />
      ) : null}
    </section>
  );
}

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
  LoaderCircle,
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
import { joinContextMenuSections } from "@/components/ui/context-menu-items";
import { dispatchAppCommand, listenForAppCommands } from "@/lib/appCommands";
import { getAppShortcut, isBrowserShortcut } from "@/lib/keyboardShortcuts";
import {
  calculatePaneLayout,
  focusedPane,
  MAX_TERMINAL_PANES,
  paneLeaves,
  paneTabIds,
} from "@/lib/paneLayout";
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
  terminalService,
  type ProfileInput,
} from "@/services";
import { useProjectStore } from "@/stores/projectStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTemplateStore } from "@/stores/templateStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { cn } from "@/lib/utils";
import type {
  Project,
  TerminalProfile,
  TerminalSplitDirection,
  TerminalTab,
} from "@/types";

import { TerminalPane } from "./TerminalPane";
import { preloadTerminalView } from "./terminalViewLoader";
import { useTerminalTabDrag } from "./useTerminalTabDrag";

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
  const addSplitPane = useTerminalStore((s) => s.splitPane);
  const replaceSplitTab = useTerminalStore((s) => s.replaceSplitTab);
  const focusSplitPane = useTerminalStore((s) => s.focusSplitPane);
  const focusRelativePane = useTerminalStore((s) => s.focusRelativePane);
  const resizeSplit = useTerminalStore((s) => s.resizeSplit);
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
  const [menuPosition, setMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [plusMenuPosition, setPlusMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [condaEnvs, setCondaEnvs] = useState<CondaEnvOption[]>([]);
  const condaDetectionProjectRef = useRef<string | null>(null);
  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId),
    [projects, activeProjectId],
  );
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId),
    [profiles, selectedProfileId],
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
  const splitTabIds = useMemo(() => paneTabIds(splitView), [splitView]);
  const validSplitView = useMemo(
    () =>
      splitView &&
      splitTabIds.length >= 2 &&
      splitTabIds.every((id) => tabIds.includes(id))
        ? splitView
        : undefined,
    [splitView, splitTabIds, tabIds],
  );
  const splitTabIdSet = useMemo(
    () => new Set(validSplitView ? splitTabIds : []),
    [validSplitView, splitTabIds],
  );
  const focusedSplitPane = useMemo(
    () => focusedPane(validSplitView),
    [validSplitView],
  );
  // Pane geometry keyed by tab so the render loop neither re-walks the tree per
  // tab nor hands `TerminalPane` a fresh style object on every render.
  const paneRenderByTabId = useMemo(() => {
    const map = new Map<
      string,
      { paneId: string; style: React.CSSProperties }
    >();
    if (!validSplitView) return map;
    for (const pane of calculatePaneLayout(validSplitView.root).panes) {
      map.set(pane.tabId, {
        paneId: pane.paneId,
        style: {
          left: `${pane.left}%`,
          top: `${pane.top}%`,
          width: `${pane.width}%`,
          height: `${pane.height}%`,
        },
      });
    }
    return map;
  }, [validSplitView]);
  const paneLayout = useMemo(
    () =>
      validSplitView ? calculatePaneLayout(validSplitView.root) : undefined,
    [validSplitView],
  );

  const handleNewTerminal = useCallback(
    async (projectId: string, preferredProfileId?: string) => {
      setError(null);
      // xterm is intentionally absent from the initial bundle. Start loading
      // it now so parsing overlaps the slower backend process launch.
      preloadTerminalView();
      let pendingTabId: string | null = null;
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
        pendingTabId = crypto.randomUUID();
        const now = Date.now();
        registerTab({
          id: pendingTabId,
          sessionId: null,
          projectId,
          profileId: profile.id,
          defaultTitle: profile.name,
          title: profile.name,
          cwd: "",
          status: "starting",
          createdAt: now,
          lastActivatedAt: now,
        });
        const sessionId = await terminalService.create({
          projectId,
          profileId: profile.id,
          rows: 24,
          cols: 80,
          scrollbackMegabytes:
            useSettingsStore.getState().terminalScrollbackMegabytes,
        });
        // The user may close the loading tab while process creation is still
        // in flight. Do not leak the resulting backend session in that race.
        if (!useTerminalStore.getState().tabsById[pendingTabId]) {
          await terminalService.close(sessionId);
          return null;
        }
        updateTab(pendingTabId, { sessionId, status: "running" });
        return pendingTabId;
      } catch (e) {
        const err = e as { message?: string };
        if (
          pendingTabId &&
          useTerminalStore.getState().tabsById[pendingTabId]
        ) {
          updateTab(pendingTabId, { status: "error" });
        }
        setError(err.message ?? t("Failed to start terminal"));
        return null;
      }
    },
    [activeProjectId, profiles, registerTab, t, updateTab],
  );

  const handleSplitTerminal = useCallback(
    async (direction: TerminalSplitDirection) => {
      if (!activeProjectId) return;
      const sourceTabId = focusedSplitPane?.tabId ?? activeTabId;
      if (!sourceTabId) return;
      if (
        validSplitView &&
        paneLeaves(validSplitView.root).length >= MAX_TERMINAL_PANES
      ) {
        setError(t("A split group can contain at most four panes."));
        return;
      }

      const newTabId = await handleNewTerminal(
        activeProjectId,
        selectedProfileId,
      );
      if (!newTabId) return;
      if (validSplitView && focusedSplitPane) {
        addSplitPane(
          activeProjectId,
          focusedSplitPane.paneId,
          newTabId,
          direction,
        );
      } else {
        setSplitView(activeProjectId, [sourceTabId, newTabId], direction);
      }
      setActiveTab(activeProjectId, newTabId);
    },
    [
      addSplitPane,
      activeProjectId,
      activeTabId,
      handleNewTerminal,
      selectedProfileId,
      setActiveTab,
      setSplitView,
      t,
      validSplitView,
      focusedSplitPane,
    ],
  );

  const handleSelectTab = useCallback(
    (tabId: string) => {
      if (!activeProjectId) return;
      if (validSplitView) {
        const pane = paneLeaves(validSplitView.root).find(
          (item) => item.tabId === tabId,
        );
        if (pane) {
          focusSplitPane(activeProjectId, pane.paneId);
        } else {
          const focused = focusedPane(validSplitView);
          if (focused) {
            replaceSplitTab(activeProjectId, focused.paneId, tabId);
          }
        }
      }
      setActiveTab(activeProjectId, tabId);
    },
    [
      activeProjectId,
      focusSplitPane,
      replaceSplitTab,
      setActiveTab,
      validSplitView,
    ],
  );

  const {
    draggedTabId,
    dropZone,
    tabDropTarget,
    tabListRef,
    splitTabGroupRef,
    workspaceRef,
    previewRef,
    handleTabPointerDown,
    handleTabPointerMove,
    handleTabPointerUp,
    handleTabPointerCancel,
    handleTabClick,
  } = useTerminalTabDrag({
    activeProjectId,
    activeTabId,
    tabIds,
    tabsById,
    splitView: validSplitView,
    onSelectTab: handleSelectTab,
    setActiveTab,
    setSplitView,
    clearSplitView,
    reorderTab,
  });

  useEffect(() => {
    if (!activeTabId) return;
    tabListRef.current
      ?.querySelector<HTMLElement>("[data-active='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabListRef]);

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
    if (!plusMenuPosition) return;
    if (!activeProjectId || !activeProject || activeProject.type === "ssh") {
      setCondaEnvs([]);
      return;
    }
    if (condaDetectionProjectRef.current === activeProjectId) return;
    setCondaEnvs([]);
    condaDetectionProjectRef.current = activeProjectId;
    const detectedProjectId = activeProjectId;
    let cancelled = false;
    let completed = false;
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
        if (!cancelled) {
          condaDetectionProjectRef.current = null;
          setCondaEnvs([]);
        }
      } finally {
        completed = true;
      }
    })();
    return () => {
      cancelled = true;
      if (
        !completed &&
        condaDetectionProjectRef.current === detectedProjectId
      ) {
        condaDetectionProjectRef.current = null;
      }
    };
  }, [activeProjectId, activeProject, plusMenuPosition]);

  // Load global profile templates for the + quick-launch menu.
  useEffect(() => {
    if (plusMenuPosition && !templatesLoaded) void loadTemplates();
  }, [plusMenuPosition, templatesLoaded, loadTemplates]);

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
          scrollbackMegabytes:
            useSettingsStore.getState().terminalScrollbackMegabytes,
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

  async function handleRestart(tabId: string) {
    const oldTab = tabsById[tabId];
    if (!oldTab) return;
    setError(null);
    updateTab(tabId, { status: "starting", exitCode: undefined });
    try {
      const sessionId = oldTab.sessionId
        ? await terminalService.restart(oldTab.sessionId)
        : await terminalService.create({
            projectId: oldTab.projectId,
            profileId: oldTab.profileId,
            rows: 24,
            cols: 80,
            scrollbackMegabytes:
              useSettingsStore.getState().terminalScrollbackMegabytes,
          });
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
        if (tab.sessionId) await terminalService.close(tab.sessionId);
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
    const groupTabs = paneTabIds(validSplitView)
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
        groupTabs
          .filter((tab): tab is TerminalTab & { sessionId: string } =>
            Boolean(tab.sessionId),
          )
          .map((tab) => terminalService.close(tab.sessionId)),
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

  // Mirrored into a ref so the window listener below can subscribe once.
  // Otherwise every tab title change and every split-drag pointermove would
  // tear the capture-phase listener down and re-add it.
  const shortcutContextRef = useRef({
    activeProjectId,
    activeTabId,
    tabIds,
    validSplitView,
    handleCloseTab,
    handleNewTerminal,
    handleSelectTab,
    handleSplitTerminal,
    focusRelativePane,
    setActiveTab,
    selectRelativeTab,
  });
  shortcutContextRef.current = {
    activeProjectId,
    activeTabId,
    tabIds,
    validSplitView,
    handleCloseTab,
    handleNewTerminal,
    handleSelectTab,
    handleSplitTerminal,
    focusRelativePane,
    setActiveTab,
    selectRelativeTab,
  };

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

      const {
        activeProjectId,
        activeTabId,
        tabIds,
        validSplitView,
        handleCloseTab,
        handleNewTerminal,
        handleSelectTab,
        handleSplitTerminal,
        focusRelativePane,
        setActiveTab,
        selectRelativeTab,
      } = shortcutContextRef.current;

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
        case "split-pane":
          void handleSplitTerminal(shortcut.direction);
          break;
        case "focus-pane":
          if (activeProjectId && validSplitView) {
            focusRelativePane(activeProjectId, shortcut.delta);
            const next = focusedPane(
              useTerminalStore.getState().splitViewsByProjectId[
                activeProjectId
              ],
            );
            if (next) setActiveTab(activeProjectId, next.tabId);
          }
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
  }, []);

  const handleSplitResizeStart = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      split: NonNullable<typeof paneLayout>["splits"][number],
    ) => {
      if (!activeProjectId || !workspaceRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      const workspaceBounds = workspaceRef.current.getBoundingClientRect();
      const onMove = (moveEvent: PointerEvent) => {
        const splitLeft =
          workspaceBounds.left + (workspaceBounds.width * split.left) / 100;
        const splitTop =
          workspaceBounds.top + (workspaceBounds.height * split.top) / 100;
        const splitWidth = (workspaceBounds.width * split.width) / 100;
        const splitHeight = (workspaceBounds.height * split.height) / 100;
        const ratio =
          split.direction === "horizontal"
            ? (moveEvent.clientX - splitLeft) / splitWidth
            : (moveEvent.clientY - splitTop) / splitHeight;
        resizeSplit(activeProjectId, split.paneId, ratio);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    },
    [activeProjectId, resizeSplit, workspaceRef],
  );

  const hasAnyTab = Object.keys(tabsById).length > 0;
  const selectTerminalPaneRef = useRef(handleSelectTab);
  selectTerminalPaneRef.current = handleSelectTab;
  const selectTerminalPane = useCallback(
    (tabId: string) => selectTerminalPaneRef.current(tabId),
    [],
  );
  // An inline closure here would give every `TerminalPane` a new prop on every
  // workspace render, defeating their `memo`.
  const restartTerminalPaneRef = useRef(handleRestart);
  restartTerminalPaneRef.current = handleRestart;
  const restartTerminalPane = useCallback((tabId: string) => {
    void restartTerminalPaneRef.current(tabId);
  }, []);

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
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          event.stopPropagation();
          void handleCloseTab(id);
        }}
        onPointerDown={(event) => handleTabPointerDown(event, id)}
        onPointerMove={handleTabPointerMove}
        onPointerUp={handleTabPointerUp}
        onPointerCancel={handleTabPointerCancel}
        className={cn(
          "group relative flex shrink-0 cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground data-[dragging=true]:opacity-50",
          id === activeTabId &&
            "bg-accent text-accent-foreground after:pointer-events-none after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary",
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
              "pointer-events-none absolute bottom-1 top-1 z-10 w-0.5 rounded-full bg-primary",
              tabDropTarget.position === "before" ? "-left-1" : "-right-1",
            )}
          />
        ) : null}
        <div className="flex flex-col items-start">
          <span className="max-w-[160px] truncate">{tab.title}</span>
          {["starting", "connecting", "initializing"].includes(tab.status) ? (
            <span className="flex items-center gap-1 text-[10px] text-primary">
              <LoaderCircle className="h-2.5 w-2.5 animate-spin" />
              {t("Starting terminal…")}
            </span>
          ) : tab.status === "exited" || tab.status === "error" ? (
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
            className="rounded p-0.5 opacity-60 transition-colors hover:bg-foreground/10 hover:opacity-100"
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
          className="rounded p-0.5 opacity-60 transition-colors hover:bg-foreground/10 hover:opacity-100"
          aria-label={t("Close tab")}
        >
          <X className="h-3.5 w-3.5" />
        </span>
      </button>
    );
  };

  // Built only while the menu is open: this walks every profile, template,
  // built-in preset and Conda env, and the result is discarded otherwise.
  const plusMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!plusMenuPosition) return [];

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
    // name. A materialized profile wins over built-ins and Conda. Saved
    // templates are deliberately absent: they are added to a project from
    // Settings › Terminal profiles, not launched implicitly from here.
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

    return joinContextMenuSections(profileMenuItems, quickLaunchItems, [
      {
        label: t("Manage profiles…"),
        icon: Settings2,
        onSelect: () =>
          dispatchAppCommand({
            type: "open-settings",
            section: "profiles",
          }),
      },
    ]);
  }, [
    plusMenuPosition,
    activeProjectId,
    condaEnvs,
    contextMenuProfiles,
    handleNewTerminal,
    handleQuickLaunch,
    profiles,
    t,
    templateList,
  ]);

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
          className="pointer-events-none fixed left-0 top-0 z-[60] flex max-w-56 will-change-transform items-center gap-2 rounded-md border border-primary/60 bg-popover px-3 py-2 text-xs text-foreground opacity-90 shadow-md"
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
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-primary/40 bg-primary/5 p-1"
                >
                  <span className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t("Split")}
                  </span>
                  {splitTabIds.map(renderTerminalTab)}
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
                .filter((id) => !splitTabIdSet.has(id))
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
              className="group h-7 w-36 shrink-0 gap-1.5 rounded-md border-border px-2 text-xs font-medium transition-colors hover:bg-accent/60 focus:ring-1 focus:ring-ring [&>svg:last-child]:h-3.5 [&>svg:last-child]:w-3.5 [&>svg:last-child]:transition-transform data-[state=open]:border-ring data-[state=open]:bg-accent/60 data-[state=open]:[&>svg:last-child]:rotate-180"
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
              className="min-w-44 rounded-md border-border"
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
              "pointer-events-none absolute z-30 flex items-center justify-center rounded-md border-2 border-primary bg-primary/10 text-xs font-medium text-primary transition-all duration-150 ease-out",
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
              const pane = paneRenderByTabId.get(tab.id);
              const isSplitPane =
                tab.projectId === activeProjectId && Boolean(pane);
              const visible = isSplitPane || tab.id === activeTabId;
              return (
                <TerminalPane
                  key={tab.id}
                  tabId={tab.id}
                  visible={visible}
                  focused={
                    isSplitPane
                      ? focusedSplitPane?.paneId === pane?.paneId
                      : tab.id === activeTabId
                  }
                  // Only a split shows more than one terminal at a time, so
                  // only a split needs to say which one has the keyboard.
                  splitActive={isSplitPane}
                  panePosition={pane ? "" : "inset-0"}
                  style={pane?.style}
                  onSelect={selectTerminalPane}
                  onRestart={restartTerminalPane}
                />
              );
            })}
            {paneLayout?.splits.map((split) => {
              const horizontal = split.direction === "horizontal";
              const position = horizontal
                ? {
                    left: `${split.left + split.width * split.ratio}%`,
                    top: `${split.top}%`,
                    height: `${split.height}%`,
                  }
                : {
                    left: `${split.left}%`,
                    top: `${split.top + split.height * split.ratio}%`,
                    width: `${split.width}%`,
                  };
              return (
                <div
                  key={split.paneId}
                  role="separator"
                  aria-orientation={horizontal ? "vertical" : "horizontal"}
                  aria-valuenow={Math.round(split.ratio * 100)}
                  className={cn(
                    "absolute z-20 bg-border/80 transition-colors hover:bg-primary",
                    horizontal
                      ? "-ml-0.5 w-1 cursor-col-resize"
                      : "-mt-0.5 h-1 cursor-row-resize",
                  )}
                  style={position}
                  onPointerDown={(event) =>
                    handleSplitResizeStart(event, split)
                  }
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

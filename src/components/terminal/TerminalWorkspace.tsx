import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, RotateCcw, Terminal as TerminalIcon, X } from "lucide-react";

import { ContextMenu } from "@/components/ui/context-menu";
import { dispatchAppCommand, listenForAppCommands } from "@/lib/appCommands";
import { getAppShortcut, isBrowserShortcut } from "@/lib/keyboardShortcuts";
import { profileService } from "@/services";
import { useProjectStore } from "@/stores/projectStore";
import { useTerminalStore } from "@/stores/terminalStore";
import { cn } from "@/lib/utils";
import type { TerminalProfile, TerminalTab } from "@/types";

import { TerminalView } from "./TerminalView";

/**
 * Terminal workspace: tab strip + terminal area.
 *
 * Plan §10/§25.5: render EVERY project's TerminalViews at once. Non-active
 * projects have their containers hidden via CSS `display:none`. Switching
 * projects only changes which container is visible - the PTY readers and
 * xterm instances for other projects keep running. This is the core
 * invariant: project switching must NOT close sessions or dispose xterm.
 *
 * Each TerminalView owns its backend PTY (create_terminal) and routes output
 * bytes from its own Tauri Channel into its xterm instance.
 */
export function TerminalWorkspace() {
  const activeProjectId = useTerminalStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const tabsById = useTerminalStore((s) => s.tabsById);
  const tabGroups = useTerminalStore((s) => s.tabGroupsByProjectId);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const registerTab = useTerminalStore((s) => s.registerTab);
  const updateTab = useTerminalStore((s) => s.updateTab);
  const removeTab = useTerminalStore((s) => s.removeTab);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [menuPosition, setMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const group = activeProjectId ? tabGroups[activeProjectId] : undefined;
  const tabIds = useMemo(() => group?.tabIds ?? [], [group]);
  const activeTabId = group?.activeTabId ?? null;

  const handleNewTerminal = useCallback(
    async (projectId: string, preferredProfileId?: string) => {
      setError(null);
      try {
        const profiles = await profileService.list(projectId);
        if (profiles.length === 0) {
          setError("This project has no terminal profiles yet.");
          return;
        }
        const profile =
          profiles.find((p) => p.id === preferredProfileId) ??
          profiles.find((p) => p.isDefault) ??
          profiles[0];
        // Reserve the tab id. sessionId will be filled in by TerminalView's
        // onSessionId callback once the backend PTY is created.
        const tab: TerminalTab = {
          id: crypto.randomUUID(),
          sessionId: "",
          projectId,
          profileId: profile.id,
          title: profile.name,
          cwd: "",
          status: "starting",
          createdAt: Date.now(),
          lastActivatedAt: Date.now(),
        };
        registerTab(tab);
      } catch (e) {
        const err = e as { message?: string };
        setError(err.message ?? "Failed to start terminal");
      }
    },
    [registerTab],
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
        setProfiles(nextProfiles);
        setSelectedProfileId((current) =>
          nextProfiles.some((profile) => profile.id === current)
            ? current
            : (nextProfiles.find((profile) => profile.isDefault)?.id ??
              nextProfiles[0]?.id ??
              ""),
        );
      })
      .catch((cause) => {
        if (!cancelled)
          setError(
            (cause as { message?: string }).message ??
              "Failed to load terminal profiles",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  function handleSessionId(tabId: string, sessionId: string) {
    updateTab(tabId, { sessionId, status: "running", exitCode: undefined });
  }

  function handleExit(
    tabId: string,
    code: number | null,
    status: "exited" | "error" = "exited",
  ) {
    updateTab(tabId, { status, exitCode: code ?? undefined });
  }
  async function handleRestart(tabId: string) {
    const oldTab = tabsById[tabId];
    if (!oldTab) return;

    // TerminalView owns channel creation, so the cleanest frontend restart
    // is dropping the old tab (closing its PTY via unmount) and inserting
    // a new tab that triggers create_terminal.
    const tab: TerminalTab = {
      id: crypto.randomUUID(),
      sessionId: "",
      projectId: oldTab.projectId,
      profileId: oldTab.profileId,
      title: oldTab.title,
      cwd: oldTab.cwd,
      status: "starting",
      createdAt: Date.now(),
      lastActivatedAt: Date.now(),
    };
    registerTab(tab);
    removeTab(tabId);
  }

  const handleCloseTab = useCallback(
    async (tabId: string) => {
      // TerminalView's unmount cleanup closes the backend session, so we only
      // need to remove the tab here.
      removeTab(tabId);
    },
    [removeTab],
  );

  const selectRelativeTab = useCallback(
    (direction: 1 | -1) => {
      if (!activeProjectId || tabIds.length < 2 || !activeTabId) return;
      const currentIndex = tabIds.indexOf(activeTabId);
      const nextIndex =
        (currentIndex + direction + tabIds.length) % tabIds.length;
      setActiveTab(activeProjectId, tabIds[nextIndex]);
    },
    [activeProjectId, activeTabId, setActiveTab, tabIds],
  );

  useEffect(() => {
    return listenForAppCommands((command) => {
      if (command.type === "new-terminal") {
        void handleNewTerminal(command.projectId);
      }
    });
  }, [handleNewTerminal]);

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
          if (activeProjectId && tabId) setActiveTab(activeProjectId, tabId);
          break;
        }
        case "copy-terminal":
          dispatchAppCommand({ type: "copy-terminal" });
          break;
        case "paste-terminal":
          dispatchAppCommand({ type: "paste-terminal" });
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
    selectRelativeTab,
    setActiveTab,
  ]);

  const hasAnyTab = Object.keys(tabsById).length > 0;

  return (
    <section
      className="flex min-w-0 flex-1 flex-col"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="flex h-10 items-center gap-1 border-b border-border bg-surface px-2">
        {tabIds.length === 0 ? (
          <span className="px-2 text-xs text-muted-foreground">
            {activeProject ? "No terminals open" : "Select a project"}
          </span>
        ) : (
          tabIds.map((id) => {
            const tab = tabsById[id];
            if (!tab) return null;
            return (
              <button
                key={id}
                type="button"
                onClick={() =>
                  activeProjectId && setActiveTab(activeProjectId, id)
                }
                className={cn(
                  "group flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  id === activeTabId && "bg-accent text-accent-foreground",
                )}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (activeProjectId) setActiveTab(activeProjectId, id);
                  setMenuPosition({ x: event.clientX, y: event.clientY });
                }}
              >
                <div className="flex flex-col items-start">
                  <span className="max-w-[160px] truncate">{tab.title}</span>
                  {tab.status === "exited" || tab.status === "error" ? (
                    <span className="text-[10px] text-danger">
                      {tab.status === "error"
                        ? "Connection error"
                        : `Exited (${tab.exitCode ?? "?"})`}
                    </span>
                  ) : null}
                </div>
                {tab.status === "exited" || tab.status === "error" ? (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleRestart(id);
                    }}
                    className="opacity-50 hover:opacity-100"
                    aria-label={
                      projects.find((project) => project.id === tab.projectId)
                        ?.type === "ssh"
                        ? "Reconnect SSH terminal"
                        : "Restart tab"
                    }
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </span>
                ) : null}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCloseTab(id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.stopPropagation();
                      void handleCloseTab(id);
                    }
                  }}
                  className="opacity-50 hover:opacity-100"
                  aria-label="Close tab"
                >
                  <X className="h-3.5 w-3.5" />
                </span>
              </button>
            );
          })
        )}
        <div className="flex-1" />
        {activeProject && profiles.length > 1 ? (
          <select
            aria-label="Terminal profile"
            className="h-7 max-w-44 rounded border border-border bg-background px-2 text-xs"
            value={selectedProfileId}
            onChange={(event) => setSelectedProfileId(event.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label="New terminal"
          className="h-7 w-7 text-muted-foreground"
          disabled={!activeProject}
          onClick={() =>
            activeProject &&
            void handleNewTerminal(activeProject.id, selectedProfileId)
          }
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      <div className="relative flex-1 bg-background">
        {activeProject && hasAnyTab ? (
          <>
            {error ? (
              <div className="absolute left-2 top-2 z-10 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : null}
            {/*
              Render EVERY project's tabs, not just the active project's.
              Switching projects only flips which container is visible.
            */}
            {Object.values(tabsById).map((tab) => {
              const tabGroup = tabGroups[tab.projectId];
              const visible =
                tab.projectId === activeProjectId &&
                tabGroup?.activeTabId === tab.id;
              return (
                <div
                  key={tab.id}
                  className={cn(
                    "absolute inset-0",
                    visible ? "block" : "hidden",
                  )}
                >
                  <TerminalView
                    pending={{
                      projectId: tab.projectId,
                      profileId: tab.profileId,
                    }}
                    active={visible}
                    onSessionId={(sessionId) =>
                      handleSessionId(tab.id, sessionId)
                    }
                    onExit={(code, status) => handleExit(tab.id, code, status)}
                    onTitleChange={(title) => updateTab(tab.id, { title })}
                  />
                </div>
              );
            })}
          </>
        ) : activeProject ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <TerminalIcon className="mr-2 h-4 w-4" />
            {error ?? `No terminals open for ${activeProject.name}.`}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select or create a project to start a terminal.
          </div>
        )}
      </div>
      {menuPosition ? (
        <ContextMenu
          position={menuPosition}
          onClose={() => setMenuPosition(null)}
          items={[
            {
              label: "New terminal",
              shortcut: "Ctrl+Shift+T",
              icon: Plus,
              disabled: !activeProject,
              onSelect: () =>
                activeProject && void handleNewTerminal(activeProject.id),
            },
            {
              label: "Close active terminal",
              shortcut: "Ctrl+Shift+W",
              icon: X,
              disabled: !activeTabId,
              onSelect: () => activeTabId && void handleCloseTab(activeTabId),
            },
          ]}
        />
      ) : null}
    </section>
  );
}

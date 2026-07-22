import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  EyeOff,
  LayoutTemplate,
  Plus,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { dispatchAppCommand, listenForAppCommands } from "@/lib/appCommands";
import { useTranslation } from "@/i18n";
import {
  BUILT_IN_PROFILE_PRESETS,
  type BuiltInProfilePreset,
  hasMaterializedPreset,
} from "@/lib/profilePresets";
import { cn } from "@/lib/utils";
import type { ProfileInput, TemplateInput } from "@/services";
import { useProfileStore } from "@/stores/profileStore";
import { useTemplateStore } from "@/stores/templateStore";
import { useProjectStore } from "@/stores/projectStore";
import { usePlatformStore } from "@/stores/platformStore";
import { useTerminalStore } from "@/stores/terminalStore";
import type {
  EnvironmentType,
  ProfileTemplate,
  ShellType,
  TerminalProfile,
} from "@/types";

import { GeneralSettingsPanel } from "./GeneralSettingsPanel";

type SettingsSection = "general" | "profiles" | "templates";

type ProfileDraft = {
  id?: string;
  builtInPresetId?: string;
  name: string;
  shellType: ShellType;
  shellExecutable: string;
  shellArgs: string;
  environmentType: EnvironmentType;
  environmentName: string;
  environmentPath: string;
  condaExecutable: string;
  condaRoot: string;
  condaActivationMode: "shell-hook" | "conda-bat" | "manual-command";
  autoActivate: boolean;
  activationCommand: string;
  startupCommands: string;
  environmentVariables: string;
  wslDistribution: string;
  wslWorkingDirectory: string;
  remoteShellCommand: string;
  isDefault: boolean;
  showInContextMenu: boolean;
};
const LOCAL_SHELLS: Array<{ value: ShellType; label: string }> = [
  { value: "powershell", label: "PowerShell" },
  { value: "cmd", label: "Command Prompt" },
  { value: "git-bash", label: "Git Bash" },
  { value: "wsl", label: "WSL" },
  { value: "bash", label: "Bash" },
  { value: "zsh", label: "Zsh" },
  { value: "fish", label: "Fish" },
  { value: "sh", label: "sh" },
  { value: "custom", label: "Custom executable" },
];

/** Filter the local shell list down to what the current host offers. Falls
 * back to the Windows set when the platform snapshot has not loaded yet so
 * the picker is never empty during the brief initial render. */
function localShellsForPlatform(
  available: ShellType[] | undefined,
): Array<{ value: ShellType; label: string }> {
  if (!available || available.length === 0) {
    return LOCAL_SHELLS.filter((shell) =>
      ["powershell", "cmd", "git-bash", "wsl", "custom"].includes(shell.value),
    );
  }
  return LOCAL_SHELLS.filter((shell) => available.includes(shell.value));
}
const REMOTE_SHELLS: Array<{ value: ShellType; label: string }> = [
  { value: "remote-default", label: "Remote default shell" },
  { value: "remote-bash", label: "Bash" },
  { value: "remote-zsh", label: "Zsh" },
  { value: "remote-fish", label: "Fish" },
  { value: "custom", label: "Custom command" },
];

const ENVIRONMENTS: Array<{ value: EnvironmentType; label: string }> = [
  { value: "none", label: "None" },
  { value: "conda", label: "Conda" },
  { value: "venv", label: "Python venv" },
  { value: "poetry", label: "Poetry" },
  { value: "uv", label: "uv" },
  { value: "custom", label: "Custom activation" },
];

// Zustand selectors must return a stable reference when no project is
// selected. A freshly-created [] on each store read makes useSyncExternalStore
// continuously think the snapshot changed, which can blank the app at startup.
const EMPTY_PROFILES: TerminalProfile[] = [];
const EMPTY_TEMPLATES: ProfileTemplate[] = [];

function blankTemplateDraft(): ProfileDraft {
  return {
    name: "",
    shellType: "powershell",
    shellExecutable: "",
    shellArgs: "",
    environmentType: "none",
    environmentName: "",
    environmentPath: "",
    condaExecutable: "",
    condaRoot: "",
    condaActivationMode: "shell-hook",
    autoActivate: true,
    activationCommand: "",
    startupCommands: "",
    environmentVariables: "",
    wslDistribution: "",
    wslWorkingDirectory: "",
    remoteShellCommand: "",
    isDefault: false,
    showInContextMenu: true,
  };
}

function draftFromTemplate(template: ProfileTemplate): ProfileDraft {
  return {
    id: template.id,
    name: template.name,
    shellType: template.shellType,
    shellExecutable: template.shellExecutable ?? "",
    shellArgs: (template.shellArgs ?? []).join("\n"),
    environmentType: template.environmentType,
    environmentName:
      template.conda?.environmentName ?? template.environmentName ?? "",
    environmentPath:
      template.conda?.environmentPath ?? template.environmentPath ?? "",
    condaExecutable: template.conda?.condaExecutable ?? "",
    condaRoot: template.conda?.condaRoot ?? "",
    condaActivationMode: template.conda?.activationMode ?? "shell-hook",
    autoActivate: template.conda?.autoActivate ?? true,
    activationCommand: template.activationCommand ?? "",
    startupCommands: (template.startupCommands ?? []).join("\n"),
    environmentVariables: Object.entries(template.environmentVariables ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    wslDistribution: template.wslDistribution ?? "",
    wslWorkingDirectory: template.wslWorkingDirectory ?? "",
    remoteShellCommand: template.remoteShellCommand ?? "",
    isDefault: false,
    showInContextMenu: true,
  };
}

function blankDraft(projectType: "local" | "ssh" | "wsl"): ProfileDraft {
  return {
    name: "",
    shellType: projectType === "ssh" ? "remote-default" : "powershell",
    shellExecutable: "",
    shellArgs: "",
    environmentType: "none",
    environmentName: "",
    environmentPath: "",
    condaExecutable: "",
    condaRoot: "",
    condaActivationMode: "shell-hook",
    autoActivate: true,
    activationCommand: "",
    startupCommands: "",
    environmentVariables: "",
    wslDistribution: "",
    wslWorkingDirectory: "",
    remoteShellCommand: "",
    isDefault: false,
    showInContextMenu: true,
  };
}

function draftFromBuiltInPreset(
  preset: BuiltInProfilePreset,
  projectType: "local" | "ssh" | "wsl",
): ProfileDraft {
  return {
    ...blankDraft(projectType),
    builtInPresetId: preset.id,
    name: preset.name,
    startupCommands: preset.startupCommands.join("\n"),
  };
}

function draftFromProfile(profile: TerminalProfile): ProfileDraft {
  return {
    id: profile.id,
    name: profile.name,
    shellType: profile.shellType,
    shellExecutable: profile.shellExecutable ?? "",
    shellArgs: (profile.shellArgs ?? []).join("\n"),
    environmentType: profile.environmentType,
    environmentName:
      profile.conda?.environmentName ?? profile.environmentName ?? "",
    environmentPath:
      profile.conda?.environmentPath ?? profile.environmentPath ?? "",
    condaExecutable: profile.conda?.condaExecutable ?? "",
    condaRoot: profile.conda?.condaRoot ?? "",
    condaActivationMode: profile.conda?.activationMode ?? "shell-hook",
    autoActivate: profile.conda?.autoActivate ?? true,
    activationCommand: profile.activationCommand ?? "",
    startupCommands: (profile.startupCommands ?? []).join("\n"),
    environmentVariables: Object.entries(profile.environmentVariables ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    wslDistribution: profile.wslDistribution ?? "",
    wslWorkingDirectory: profile.wslWorkingDirectory ?? "",
    remoteShellCommand: profile.remoteShellCommand ?? "",
    isDefault: profile.isDefault,
    showInContextMenu: profile.showInContextMenu ?? true,
  };
}

function optional(value: string) {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function lines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseVariables(
  value: string,
  t: (source: string, params?: Record<string, string | number>) => string,
): Record<string, string> | undefined {
  const entries = lines(value).map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new Error(
        t('Invalid environment variable: "{line}". Use NAME=value.', {
          line,
        }),
      );
    }
    return [
      line.slice(0, separator).trim(),
      line.slice(separator + 1),
    ] as const;
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Settings surface for project-scoped terminal profiles. */
export function SettingsDialog() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>("general");
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useTerminalStore((s) => s.activeProjectId);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProfileDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const requestedSectionRef = useRef<SettingsSection | null>(null);

  const profiles = useProfileStore((s) =>
    projectId ? (s.byProjectId[projectId] ?? EMPTY_PROFILES) : EMPTY_PROFILES,
  );
  const loading = useProfileStore((s) =>
    projectId ? s.loadingProjectIds.has(projectId) : false,
  );
  const loadForProject = useProfileStore((s) => s.loadForProject);
  const createProfile = useProfileStore((s) => s.createProfile);
  const updateProfile = useProfileStore((s) => s.updateProfile);
  const deleteProfile = useProfileStore((s) => s.deleteProfile);
  const templates = useTemplateStore((s) => s.templates ?? EMPTY_TEMPLATES);
  const templatesLoaded = useTemplateStore((s) => s.loaded);
  const loadTemplates = useTemplateStore((s) => s.loadTemplates);
  const createTemplate = useTemplateStore((s) => s.createTemplate);
  const updateTemplate = useTemplateStore((s) => s.updateTemplate);
  const deleteTemplate = useTemplateStore((s) => s.deleteTemplate);
  const [editingTemplate, setEditingTemplate] = useState<ProfileDraft | null>(
    null,
  );
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === projectId) ?? null,
    [projects, projectId],
  );
  const uncreatedBuiltInPresets = useMemo(
    () =>
      BUILT_IN_PROFILE_PRESETS.filter(
        (preset) => !hasMaterializedPreset(profiles, preset),
      ),
    [profiles],
  );

  useEffect(() => {
    if (!open) return;
    const initialId = activeProjectId ?? projects[0]?.id ?? null;
    setSection(requestedSectionRef.current ?? "general");
    requestedSectionRef.current = null;
    setProjectId(initialId);
    setEditing(null);
    setError(null);
    setEditingTemplate(null);
    setTemplateError(null);
  }, [open, activeProjectId, projects]);

  useEffect(() => {
    if (open && section === "templates" && !templatesLoaded) {
      void loadTemplates();
    }
  }, [open, section, templatesLoaded, loadTemplates]);

  useEffect(() => {
    if (open && section === "profiles" && projectId) {
      void loadForProject(projectId);
    }
  }, [open, projectId, loadForProject, section]);

  useEffect(() => {
    return listenForAppCommands((command) => {
      if (command.type === "open-settings") {
        requestedSectionRef.current = command.section ?? null;
        setOpen(true);
      }
    });
  }, []);

  function selectProject(nextProjectId: string) {
    setProjectId(nextProjectId);
    setEditing(null);
    setError(null);
  }

  function startCreate() {
    if (!selectedProject) return;
    setEditing(blankDraft(selectedProject.type));
    setError(null);
  }

  async function saveProfile() {
    if (!editing || !selectedProject) return;
    if (!editing.name.trim()) {
      setError(t("Profile name is required."));
      return;
    }
    if (
      editing.environmentType === "conda" &&
      !editing.environmentName.trim() &&
      !editing.environmentPath.trim()
    ) {
      setError(t("Choose a Conda environment name or environment path."));
      return;
    }

    try {
      const input: ProfileInput = {
        ...(editing.id ? { id: editing.id } : {}),
        projectId: selectedProject.id,
        name: editing.name.trim(),
        shellType: editing.shellType,
        shellExecutable: optional(editing.shellExecutable),
        shellArgs: lines(editing.shellArgs),
        environmentType: editing.environmentType,
        environmentName:
          editing.environmentType === "conda"
            ? undefined
            : optional(editing.environmentName),
        environmentPath:
          editing.environmentType === "conda"
            ? undefined
            : optional(editing.environmentPath),
        conda:
          editing.environmentType === "conda"
            ? {
                condaExecutable: optional(editing.condaExecutable),
                condaRoot: optional(editing.condaRoot),
                environmentName: optional(editing.environmentName),
                environmentPath: optional(editing.environmentPath),
                activationMode: editing.condaActivationMode,
                autoActivate: editing.autoActivate,
              }
            : undefined,
        activationCommand: optional(editing.activationCommand),
        startupCommands: lines(editing.startupCommands),
        environmentVariables: parseVariables(editing.environmentVariables, t),
        wslDistribution: optional(editing.wslDistribution),
        wslWorkingDirectory: optional(editing.wslWorkingDirectory),
        remoteShellCommand: optional(editing.remoteShellCommand),
        isDefault: editing.isDefault,
        showInContextMenu: editing.showInContextMenu,
      };
      setSaving(true);
      setError(null);
      const savedProfile = editing.id
        ? await updateProfile(input)
        : await createProfile(input);
      dispatchAppCommand({
        type: "profiles-changed",
        projectId: selectedProject.id,
      });
      setEditing(
        savedProfile.showInContextMenu === false
          ? draftFromProfile(savedProfile)
          : null,
      );
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : (cause as { message?: string }).message;
      setError(message ?? t("Could not save profile."));
    } finally {
      setSaving(false);
    }
  }

  async function removeProfile(profile: TerminalProfile) {
    if (
      !projectId ||
      !window.confirm(t('Delete terminal profile "{name}"?', { name: profile.name }))
    )
      return;
    try {
      setError(null);
      await deleteProfile(profile.id, projectId);
      dispatchAppCommand({ type: "profiles-changed", projectId });
      if (editing?.id === profile.id) setEditing(null);
    } catch (cause) {
      setError(
        (cause as { message?: string }).message ?? t("Could not delete profile."),
      );
    }
  }

  async function saveTemplate() {
    if (!editingTemplate) return;
    if (!editingTemplate.name.trim()) {
      setTemplateError(t("Template name is required."));
      return;
    }
    if (
      editingTemplate.environmentType === "conda" &&
      !editingTemplate.environmentName.trim() &&
      !editingTemplate.environmentPath.trim()
    ) {
      setTemplateError(t("Choose a Conda environment name or environment path."));
      return;
    }

    try {
      const input: TemplateInput = {
        ...(editingTemplate.id ? { id: editingTemplate.id } : {}),
        name: editingTemplate.name.trim(),
        shellType: editingTemplate.shellType,
        shellExecutable: optional(editingTemplate.shellExecutable),
        shellArgs: lines(editingTemplate.shellArgs),
        environmentType: editingTemplate.environmentType,
        environmentName:
          editingTemplate.environmentType === "conda"
            ? undefined
            : optional(editingTemplate.environmentName),
        environmentPath:
          editingTemplate.environmentType === "conda"
            ? undefined
            : optional(editingTemplate.environmentPath),
        conda:
          editingTemplate.environmentType === "conda"
            ? {
                condaExecutable: optional(editingTemplate.condaExecutable),
                condaRoot: optional(editingTemplate.condaRoot),
                environmentName: optional(editingTemplate.environmentName),
                environmentPath: optional(editingTemplate.environmentPath),
                activationMode: editingTemplate.condaActivationMode,
                autoActivate: editingTemplate.autoActivate,
              }
            : undefined,
        activationCommand: optional(editingTemplate.activationCommand),
        startupCommands: lines(editingTemplate.startupCommands),
        environmentVariables: parseVariables(
          editingTemplate.environmentVariables,
          t,
        ),
        wslDistribution: optional(editingTemplate.wslDistribution),
        wslWorkingDirectory: optional(editingTemplate.wslWorkingDirectory),
        remoteShellCommand: optional(editingTemplate.remoteShellCommand),
      };
      setSavingTemplate(true);
      setTemplateError(null);
      if (editingTemplate.id) await updateTemplate(input);
      else await createTemplate(input);
      setEditingTemplate(null);
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : (cause as { message?: string }).message;
      setTemplateError(message ?? t("Could not save template."));
    } finally {
      setSavingTemplate(false);
    }
  }

  async function removeTemplate(template: ProfileTemplate) {
    if (!window.confirm(t('Delete profile template "{name}"?', { name: template.name }))) return;
    try {
      setTemplateError(null);
      await deleteTemplate(template.id);
      if (editingTemplate?.id === template.id) setEditingTemplate(null);
    } catch (cause) {
      setTemplateError(
        (cause as { message?: string }).message ?? t("Could not delete template."),
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="secondary"
        size="icon"
        aria-label={t("Settings")}
        onClick={() => setOpen(true)}
      >
        <Settings className="h-4 w-4" />
      </Button>
      <DialogContent className="flex h-[min(720px,calc(100vh-2rem))] max-w-5xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle>{t("Settings")}</DialogTitle>
          <DialogDescription>
            {section === "general"
              ? t("Manage application-wide preferences.")
              : section === "templates"
                ? t(
                    "Create reusable profile templates to quickly add to any project.",
                  )
                : t("Configure terminal profiles for each project.")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-56 shrink-0 flex-col border-r bg-surface p-3">
            <nav className="space-y-1" aria-label={t("Settings sections")}>
              <SettingsNavItem
                active={section === "general"}
                icon={SlidersHorizontal}
                label={t("General")}
                onClick={() => {
                  setSection("general");
                  setError(null);
                }}
              />
              <SettingsNavItem
                active={section === "profiles"}
                icon={SquareTerminal}
                label={t("Terminal profiles")}
                onClick={() => setSection("profiles")}
              />
              <SettingsNavItem
                active={section === "templates"}
                icon={LayoutTemplate}
                label={t("Profile templates")}
                onClick={() => {
                  setSection("templates");
                  setError(null);
                }}
              />
            </nav>

            {section === "profiles" ? (
              <div className="mt-4 flex min-h-0 flex-1 flex-col border-t pt-4">
                <span className="px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("Project")}
                </span>
                {projects.length ? (
                  <Select
                    value={projectId ?? undefined}
                    onValueChange={selectProject}
                  >
                    <SelectTrigger className="mb-3 h-9">
                      <SelectValue placeholder={t("Select a project")} />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
                <div className="app-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto">
                  {loading ? (
                    <p className="px-2 py-3 text-xs text-muted-foreground">
                      {t("Loading profiles…")}
                    </p>
                  ) : null}
                  {!loading &&
                    profiles.map((profile) => (
                      <button
                        key={profile.id}
                        type="button"
                        onClick={() => {
                          setEditing(draftFromProfile(profile));
                          setError(null);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent",
                          editing?.id === profile.id && "bg-accent",
                        )}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {profile.name}
                        </span>
                        {profile.showInContextMenu === false ? (
                          <EyeOff
                            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                            aria-label={t("Hidden from + menu")}
                          />
                        ) : null}
                        {profile.isDefault ? (
                          <Check
                            className="h-3.5 w-3.5 shrink-0 text-ok"
                            aria-label={t("Default profile")}
                          />
                        ) : null}
                      </button>
                    ))}
                  {!loading &&
                    selectedProject &&
                    uncreatedBuiltInPresets.map((preset) => (
                      <button
                        key={`built-in-${preset.id}`}
                        type="button"
                        onClick={() => {
                          setEditing(
                            draftFromBuiltInPreset(
                              preset,
                              selectedProject.type,
                            ),
                          );
                          setError(null);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent",
                          editing?.builtInPresetId === preset.id && "bg-accent",
                        )}
                      >
                        <Sparkles
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          aria-label={t("Built-in profile")}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {preset.name}
                        </span>
                      </button>
                    ))}
                  {!loading &&
                  selectedProject &&
                  !profiles.length &&
                  !uncreatedBuiltInPresets.length ? (
                    <p className="px-2 py-3 text-xs text-muted-foreground">
                      {t("No profiles yet.")}
                    </p>
                  ) : null}
                  {!selectedProject ? (
                    <p className="px-2 py-3 text-xs text-muted-foreground">
                      {t("Add a project to create profiles.")}
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={startCreate}
                  disabled={!selectedProject}
                  className="mt-3 w-full justify-start"
                >
                  <Plus className="h-4 w-4" /> {t("New profile")}
                </Button>
              </div>
            ) : section === "templates" ? (
              <div className="mt-4 flex min-h-0 flex-1 flex-col border-t pt-4">
                <span className="px-2 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("Templates")}
                </span>
                <div className="app-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto">
                  {templates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => {
                        setEditingTemplate(draftFromTemplate(template));
                        setTemplateError(null);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent",
                        editingTemplate?.id === template.id && "bg-accent",
                      )}
                    >
                      <LayoutTemplate className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">
                        {template.name}
                      </span>
                    </button>
                  ))}
                  {templates.length === 0 ? (
                    <p className="px-2 py-3 text-xs text-muted-foreground">
                      {t("No templates yet.")}
                    </p>
                  ) : null}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setEditingTemplate(blankTemplateDraft());
                    setTemplateError(null);
                  }}
                  className="mt-3 w-full justify-start"
                >
                  <Plus className="h-4 w-4" /> {t("New template")}
                </Button>
              </div>
            ) : (
              <p className="mt-auto px-2 py-2 text-xs leading-relaxed text-muted-foreground">
                {t("Preferences are stored locally and applied automatically.")}
              </p>
            )}
          </aside>

          <main className="app-scrollbar min-w-0 flex-1 overflow-y-auto p-6">
            {section === "general" ? (
              <GeneralSettingsPanel />
            ) : section === "templates" && editingTemplate ? (
              <ProfileForm
                draft={editingTemplate}
                projectType="local"
                saving={savingTemplate}
                error={templateError}
                onChange={setEditingTemplate}
                onCancel={() => {
                  setEditingTemplate(null);
                  setTemplateError(null);
                }}
                onSave={() => void saveTemplate()}
                showProjectOptions={false}
                onDelete={
                  editingTemplate.id
                    ? () => {
                        const template = templates.find(
                          (item) => item.id === editingTemplate.id,
                        );
                        if (template) void removeTemplate(template);
                      }
                    : undefined
                }
              />
            ) : editing && selectedProject ? (
              <ProfileForm
                draft={editing}
                projectType={selectedProject.type}
                saving={saving}
                error={error}
                onChange={setEditing}
                onCancel={() => {
                  setEditing(null);
                  setError(null);
                }}
                onSave={() => void saveProfile()}
                onDelete={
                  editing.id
                    ? () => {
                        const profile = profiles.find(
                          (item) => item.id === editing.id,
                        );
                        if (profile) void removeProfile(profile);
                      }
                    : undefined
                }
              />
            ) : (
              <div className="flex h-full min-h-52 items-center justify-center text-center text-sm text-muted-foreground">
                {t("Select a profile to edit it, or create a new one.")}
              </div>
            )}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProfileForm({
  draft,
  projectType,
  saving,
  error,
  onChange,
  onCancel,
  onSave,
  onDelete,
  showProjectOptions = true,
}: {
  draft: ProfileDraft;
  projectType: "local" | "ssh" | "wsl";
  saving: boolean;
  error: string | null;
  onChange: (draft: ProfileDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  onDelete?: () => void;
  showProjectOptions?: boolean;
}) {
  const { t } = useTranslation();
  const platformInfo = usePlatformStore((state) => state.info);
  const update = <K extends keyof ProfileDraft>(
    key: K,
    value: ProfileDraft[K],
  ) => onChange({ ...draft, [key]: value });
  const shells =
    projectType === "ssh"
      ? REMOTE_SHELLS
      : localShellsForPlatform(platformInfo?.availableLocalShells);
  const environmentNeedsPath =
    draft.environmentType !== "none" &&
    draft.environmentType !== "conda" &&
    draft.environmentType !== "custom";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold">
          {draft.id
            ? t("Edit profile")
            : draft.builtInPresetId
              ? t("Set up built-in profile")
              : t("New profile")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {draft.builtInPresetId
            ? t(
                "Save to customize this built-in profile for the selected project.",
              )
            : t("This profile is used only by the selected project.")}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("Profile name")}>
          <Input
            value={draft.name}
            onChange={(event) => update("name", event.target.value)}
            autoFocus
            placeholder={t("e.g. Python environment")}
          />
        </Field>
        <Field label={t("Shell")}>
          <Select
            value={draft.shellType}
            onValueChange={(value) => update("shellType", value as ShellType)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {shells.map((shell) => (
                <SelectItem key={shell.value} value={shell.value}>
                  {t(shell.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      {draft.shellType === "custom" ? (
        <Field
          label={
            projectType === "ssh"
              ? t("Remote shell command")
              : t("Shell executable")
          }
        >
          <Input
            value={
              projectType === "ssh"
                ? draft.remoteShellCommand
                : draft.shellExecutable
            }
            onChange={(event) =>
              update(
                projectType === "ssh"
                  ? "remoteShellCommand"
                  : "shellExecutable",
                event.target.value,
              )
            }
            placeholder={
              projectType === "ssh"
                ? t("e.g. /usr/bin/bash")
                : t("e.g. C:\\Tools\\shell.exe")
            }
          />
        </Field>
      ) : null}
      {draft.shellType === "wsl" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("WSL distribution")}>
            <Input
              value={draft.wslDistribution}
              onChange={(event) =>
                update("wslDistribution", event.target.value)
              }
              placeholder={t("e.g. Ubuntu")}
            />
          </Field>
          <Field label={t("WSL working directory")}>
            <Input
              value={draft.wslWorkingDirectory}
              onChange={(event) =>
                update("wslWorkingDirectory", event.target.value)
              }
              placeholder={t("Optional Linux path")}
            />
          </Field>
        </div>
      ) : null}
      <Field label={t("Shell arguments")} hint={t("One argument per line")}>
        <textarea
          className="form-textarea min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={draft.shellArgs}
          onChange={(event) => update("shellArgs", event.target.value)}
          placeholder="-NoLogo"
        />
      </Field>
      <div className="border-t pt-6">
        <h3 className="font-medium">{t("Environment")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "The application only activates an existing environment; it never changes it.",
          )}
        </p>
      </div>
      <Field label={t("Environment type")}>
        <Select
          value={draft.environmentType}
          onValueChange={(value) =>
            update("environmentType", value as EnvironmentType)
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ENVIRONMENTS.map((environment) => (
              <SelectItem key={environment.value} value={environment.value}>
                {t(environment.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {draft.environmentType === "conda" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("Environment name")}>
              <Input
                value={draft.environmentName}
                onChange={(event) =>
                  update("environmentName", event.target.value)
                }
                placeholder={t("e.g. my-env")}
              />
            </Field>
            <Field label={t("Environment path")}>
              <Input
                value={draft.environmentPath}
                onChange={(event) =>
                  update("environmentPath", event.target.value)
                }
                placeholder={t("Alternative to name")}
              />
            </Field>
            <Field label={t("Conda executable")}>
              <Input
                value={draft.condaExecutable}
                onChange={(event) =>
                  update("condaExecutable", event.target.value)
                }
                placeholder={t("Optional path to conda.exe")}
              />
            </Field>
            <Field label={t("Conda root")}>
              <Input
                value={draft.condaRoot}
                onChange={(event) => update("condaRoot", event.target.value)}
                placeholder={t("Optional installation folder")}
              />
            </Field>
          </div>
          <Field label={t("Activation method")}>
            <Select
              value={draft.condaActivationMode}
              onValueChange={(value) =>
                update(
                  "condaActivationMode",
                  value as ProfileDraft["condaActivationMode"],
                )
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shell-hook">{t("Shell hook")}</SelectItem>
                <SelectItem value="conda-bat">conda.bat</SelectItem>
                <SelectItem value="manual-command">
                  {t("Manual command")}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Checkbox
            checked={draft.autoActivate}
            onChange={(checked) => update("autoActivate", checked)}
            label={t("Activate this Conda environment when the terminal opens")}
          />
        </>
      ) : null}
      {environmentNeedsPath ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Environment name")}>
            <Input
              value={draft.environmentName}
              onChange={(event) =>
                update("environmentName", event.target.value)
              }
              placeholder={t("Optional label")}
            />
          </Field>
          <Field label={t("Environment path")}>
            <Input
              value={draft.environmentPath}
              onChange={(event) =>
                update("environmentPath", event.target.value)
              }
              placeholder={t("e.g. .venv")}
            />
          </Field>
        </div>
      ) : null}
      {draft.environmentType === "custom" ? (
        <Field label={t("Activation command")}>
          <Input
            value={draft.activationCommand}
            onChange={(event) =>
              update("activationCommand", event.target.value)
            }
            placeholder={t("Command to run after opening the shell")}
          />
        </Field>
      ) : null}
      <div className="border-t pt-6">
        <h3 className="font-medium">{t("Startup")}</h3>
      </div>
      <Field label={t("Startup commands")} hint={t("One command per line")}>
        <textarea
          className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={draft.startupCommands}
          onChange={(event) => update("startupCommands", event.target.value)}
          placeholder="python --version"
        />
      </Field>
      <Field
        label={t("Environment variables")}
        hint={t("One NAME=value pair per line")}
      >
        <textarea
          className="min-h-20 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
          value={draft.environmentVariables}
          onChange={(event) =>
            update("environmentVariables", event.target.value)
          }
          placeholder="PYTHONUTF8=1"
        />
      </Field>
      {showProjectOptions ? (
        <div className="space-y-3">
          <Checkbox
            checked={draft.showInContextMenu}
            onChange={(checked) => update("showInContextMenu", checked)}
            label={t("Show this profile in the + button context menu")}
          />
          <Checkbox
            checked={draft.isDefault}
            onChange={(checked) => update("isDefault", checked)}
            label={t("Use this as the default profile for new terminals")}
          />
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
      <div className="flex items-center justify-between border-t pt-5">
        <div>
          {onDelete ? (
            <Button
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={onDelete}
              disabled={saving}
            >
              <Trash2 className="h-4 w-4" /> {t("Delete profile")}
            </Button>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            <ChevronLeft className="h-4 w-4" /> {t("Cancel")}
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving ? t("Saving…") : t("Save profile")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SettingsNavItem({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
        active && "bg-accent text-accent-foreground",
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm font-medium">
        {label}
        {hint ? (
          <span className="ml-2 font-normal text-muted-foreground">{hint}</span>
        ) : null}
      </span>
      {children}
    </label>
  );
}
function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-input accent-primary"
      />
      {label}
    </label>
  );
}

/**
 * Domain models shared between frontend and Rust backend.
 *
 * Mirrors `src-tauri/src/project/model.rs`, `profile/model.rs`, and
 * `ssh/model.rs`. Field names MUST stay in sync with the Rust serde
 * representations - they are deserialized from JSON the backend writes.
 */

export type ProjectType = "local" | "ssh" | "wsl";

export interface LocalProjectConfig {
  path: string;
}

export interface SshProjectConfig {
  connectionId: string;
  remotePath: string;
}

/** WSL project config. `distribution` is required (e.g. "Ubuntu");
 * `workingDirectory` is an optional Linux path inside the distribution. */
export interface WslProjectConfig {
  distribution: string;
  workingDirectory?: string;
}

export interface Project {
  id: string;
  name: string;
  type: ProjectType;

  local?: LocalProjectConfig;
  ssh?: SshProjectConfig;
  wsl?: WslProjectConfig;

  defaultProfileId?: string;

  createdAt: string;
  updatedAt: string;
}

export type ShellType =
  | "powershell"
  | "cmd"
  | "git-bash"
  | "wsl"
  | "bash"
  | "zsh"
  | "fish"
  | "sh"
  | "remote-default"
  | "remote-bash"
  | "remote-zsh"
  | "remote-fish"
  | "custom";

export type EnvironmentType =
  "none" | "conda" | "venv" | "poetry" | "uv" | "custom";

export type ProfileTemplateIcon =
  | "layout-template"
  | "terminal"
  | "code"
  | "bot"
  | "sparkles"
  | "box"
  | "database"
  | "server"
  | "cloud"
  | "rocket";

export type CondaActivationMode = "shell-hook" | "conda-bat" | "manual-command";

export interface CondaEnvironmentConfig {
  condaExecutable?: string;
  condaRoot?: string;

  environmentName?: string;
  environmentPath?: string;

  activationMode: CondaActivationMode;
  autoActivate: boolean;
}

export interface TerminalProfile {
  id: string;
  projectId: string;

  name: string;

  shellType: ShellType;
  shellExecutable?: string;
  shellArgs?: string[];

  environmentType: EnvironmentType;

  environmentName?: string;
  environmentPath?: string;

  conda?: CondaEnvironmentConfig;

  activationCommand?: string;
  startupCommands?: string[];

  environmentVariables?: Record<string, string>;

  wslDistribution?: string;
  wslWorkingDirectory?: string;

  remoteShellCommand?: string;
  /** Configure the shell for UTF-8 output at startup. Undefined = per-shell default. */
  forceUtf8?: boolean;
  /** Inject the OSC 7 / OSC 133 prompt hooks. Undefined = off. */
  shellIntegration?: boolean;
  /** Terminal colour scheme for this profile, overriding the global choice. */
  colorSchemeId?: string;
  /** Tab and focused-pane accent, `#rrggbb`. */
  accentColor?: string;

  isDefault: boolean;
  showInContextMenu: boolean;

  createdAt: string;
  updatedAt: string;
}

/** Reusable profile template. Project-independent: stores shell/environment
 * /startup config that can be applied to any project's terminal. */
export interface ProfileTemplate {
  id: string;
  name: string;
  icon: ProfileTemplateIcon;

  shellType: ShellType;
  shellExecutable?: string;
  shellArgs?: string[];

  environmentType: EnvironmentType;

  environmentName?: string;
  environmentPath?: string;

  conda?: CondaEnvironmentConfig;

  activationCommand?: string;
  startupCommands?: string[];

  environmentVariables?: Record<string, string>;

  wslDistribution?: string;
  wslWorkingDirectory?: string;

  remoteShellCommand?: string;
  /** Configure the shell for UTF-8 output at startup. Undefined = per-shell default. */
  forceUtf8?: boolean;
  /** Inject the OSC 7 / OSC 133 prompt hooks. Undefined = off. */
  shellIntegration?: boolean;
  /** Terminal colour scheme for this profile, overriding the global choice. */
  colorSchemeId?: string;
  /** Tab and focused-pane accent, `#rrggbb`. */
  accentColor?: string;

  createdAt: string;
  updatedAt: string;
}

export type SshAuthenticationType =
  "agent" | "key" | "password" | "keyboard-interactive" | "system-config";

export interface SshJumpHost {
  host: string;
  port: number;
  username?: string;
}

export interface SshConnection {
  id: string;
  name: string;

  host: string;
  port: number;
  username: string;

  authenticationType: SshAuthenticationType;
  /** The secret itself stays in the operating-system credential vault. */
  passwordSaved: boolean;

  identityFile?: string;
  useSshAgent: boolean;

  jumpHost?: SshJumpHost;

  connectTimeoutSeconds: number;
  serverAliveIntervalSeconds: number;
  serverAliveCountMax: number;

  strictHostKeyChecking: boolean;
  knownHostsFile?: string;

  extraArgs?: string[];

  createdAt: string;
  updatedAt: string;
}

export type TerminalStatus =
  "starting" | "connecting" | "initializing" | "running" | "exited" | "error";

export interface TerminalTab {
  id: string;
  /** Null after restoring a workspace from disk; the prior PTY has ended. */
  sessionId: string | null;

  projectId: string;
  profileId: string;

  /** Stable profile label used when a program emits a transient window title. */
  defaultTitle: string;
  title: string;
  /**
   * Where the shell reported it is, via OSC 7.
   *
   * Empty until shell integration is enabled on the profile and the shell
   * reports - nothing else can know this, because the shell's directory is
   * not the PTY's.
   */
  cwd: string;

  status: TerminalStatus;
  exitCode?: number;
  /** Exit status of the last command, via OSC 133 D. Needs integration on. */
  lastCommandExitCode?: number;

  createdAt: number;
  lastActivatedAt: number;
}

export interface ProjectTabGroup {
  projectId: string;
  tabIds: string[];
  activeTabId: string | null;
}

/** User-facing split direction. */
export type TerminalSplitDirection = "side-by-side" | "stacked";

export type PaneNode =
  | {
      type: "terminal";
      paneId: string;
      tabId: string;
    }
  | {
      type: "split";
      paneId: string;
      direction: "horizontal" | "vertical";
      ratio: number;
      first: PaneNode;
      second: PaneNode;
    };

/** A project's persisted recursive terminal pane layout (maximum 4 leaves). */
export interface TerminalSplitView {
  root: PaneNode;
  focusedPaneId: string;
}

/**
 * Host platform capability snapshot. Returned once per session by the
 * `get_platform_info` Tauri command. Components MUST consume this instead of
 * hardcoding `navigator.platform` checks so saved profiles remain portable.
 */
export type HostOs = "windows" | "linux" | "macos" | "other";

export interface PlatformInfo {
  os: HostOs;
  /**
   * Windows build number, `null` elsewhere. xterm needs it to model ConPTY's
   * resize behaviour; see `resolveWindowsPty`.
   */
  windowsBuild: number | null;
  /** True only on Windows. Gates the WSL project type, shell, and picker. */
  wslSupported: boolean;
  /** Project types the picker should offer. WSL is omitted on non-Windows. */
  availableProjectTypes: ProjectType[];
  /** Local shell variants the picker should offer for this host. */
  availableLocalShells: ShellType[];
  /** Shell to seed a new local project's default profile with. */
  defaultLocalShell: ShellType;
}

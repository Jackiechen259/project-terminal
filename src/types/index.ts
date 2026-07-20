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
  | "remote-default"
  | "remote-bash"
  | "remote-zsh"
  | "remote-fish"
  | "custom";

export type EnvironmentType =
  "none" | "conda" | "venv" | "poetry" | "uv" | "custom";

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

  isDefault: boolean;

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
  sessionId: string;

  projectId: string;
  profileId: string;

  /** Stable profile label used when a program emits a transient window title. */
  defaultTitle: string;
  title: string;
  cwd: string;

  status: TerminalStatus;
  exitCode?: number;

  createdAt: number;
  lastActivatedAt: number;
}

export interface ProjectTabGroup {
  projectId: string;
  tabIds: string[];
  activeTabId: string | null;
}

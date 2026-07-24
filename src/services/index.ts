/**
 * Typed Tauri command bindings. These wrap `invoke()` calls and pin the
 * argument/return shapes. The frontend never sends raw commands - only the
 * domain-specific payloads defined here.
 */

import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";

import type {
  AgentEvent,
  AgentProfile,
  AgentSession,
  PlatformInfo,
  ProfileTemplate,
  Project,
  SshConnection,
  TerminalProfile,
} from "@/types";

/** Backend serializes AppError as `{ code, message }`. */
export interface FrontendError {
  code: string;
  message: string;
}

const PROJECT_CMD = {
  list: "list_projects",
  validate: "validate_project",
  create: "create_project",
  update: "update_project",
  delete: "delete_project",
  explorer: "open_project_in_explorer",
} as const;

const PROFILE_CMD = {
  list: "list_terminal_profiles",
  validate: "validate_terminal_profile",
  create: "create_terminal_profile",
  update: "update_terminal_profile",
  delete: "delete_terminal_profile",
  duplicate: "duplicate_terminal_profile",
  test: "test_terminal_profile",
  detectShells: "detect_local_shells",
  detectPython: "detect_python_environments",
} as const;

const TEMPLATE_CMD = {
  list: "list_profile_templates",
  create: "create_profile_template",
  update: "update_profile_template",
  delete: "delete_profile_template",
  createFromTemplate: "create_profile_from_template",
} as const;

const SSH_CMD = {
  list: "list_ssh_connections",
  validate: "validate_ssh_connection",
  create: "create_ssh_connection",
  update: "update_ssh_connection",
  delete: "delete_ssh_connection",
  test: "test_ssh_connection",
  listDirectories: "list_remote_directories",
  detect: "detect_ssh_client",
  fingerprint: "read_ssh_host_fingerprint",
} as const;

export interface ProjectInput {
  id?: string;
  name: string;
  type: "local" | "ssh" | "wsl";
  local?: { path: string };
  ssh?: { connectionId: string; remotePath: string };
  wsl?: { distribution: string; workingDirectory?: string };
  defaultProfileId?: string;
}

export interface ProfileInput {
  id?: string;
  projectId: string;
  name: string;
  shellType: TerminalProfile["shellType"];
  shellExecutable?: string;
  shellArgs?: string[];
  environmentType: TerminalProfile["environmentType"];
  environmentName?: string;
  environmentPath?: string;
  conda?: TerminalProfile["conda"];
  activationCommand?: string;
  startupCommands?: string[];
  environmentVariables?: Record<string, string>;
  wslDistribution?: string;
  wslWorkingDirectory?: string;
  remoteShellCommand?: string;
  isDefault: boolean;
  showInContextMenu: boolean;
}

export interface TemplateInput {
  id?: string;
  name: string;
  icon: ProfileTemplate["icon"];
  shellType: ProfileTemplate["shellType"];
  shellExecutable?: string;
  shellArgs?: string[];
  environmentType: ProfileTemplate["environmentType"];
  environmentName?: string;
  environmentPath?: string;
  conda?: ProfileTemplate["conda"];
  activationCommand?: string;
  startupCommands?: string[];
  environmentVariables?: Record<string, string>;
  wslDistribution?: string;
  wslWorkingDirectory?: string;
  remoteShellCommand?: string;
}

export interface SshConnectionInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authenticationType: SshConnection["authenticationType"];
  identityFile?: string;
  useSshAgent: boolean;
  jumpHost?: SshConnection["jumpHost"];
  connectTimeoutSeconds?: number;
  serverAliveIntervalSeconds?: number;
  serverAliveCountMax?: number;
  strictHostKeyChecking?: boolean;
  knownHostsFile?: string;
  extraArgs?: string[];
}

export interface AgentProfileInput {
  id?: string;
  name: string;
  projectId: string;
  terminalProfileId: string;
  command: string;
  waitingPatterns?: string[];
  approvalPatterns?: string[];
}

export interface CreateTerminalRequest {
  projectId: string;
  profileId: string;
  rows: number;
  cols: number;
  scrollbackMegabytes?: number;
}

export interface TerminalOutputChunk {
  sessionId: string;
  /** base64-encoded bytes from the PTY. */
  data?: string;
  /** Present when the backend process exits or its wait operation fails. */
  status?: "exited" | "error";
  exitCode?: number;
}

export interface SessionInfo {
  sessionId: string;
  projectId: string;
  profileId: string;
  status: "starting" | "running" | "exited" | "error";
  exitCode?: number;
  createdAt: string;
}

export interface SessionAttachment {
  session: SessionInfo;
  /** base64-encoded raw PTY history captured before live events. */
  scrollback: string;
  truncated: boolean;
}

export interface RemoteDirectoryListing {
  path: string;
  directories: Array<{ name: string; path: string }>;
}

interface ListResponse<T> {
  items: T[];
}

/** Wrap invoke so thrown errors are normalized to `FrontendError`. */
async function invokeOrThrow<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && "message" in e) {
      throw e as FrontendError;
    }
    throw {
      code: "unknown",
      message: typeof e === "string" ? e : "Unexpected error",
    } satisfies FrontendError;
  }
}

/** Decode a base64 string into bytes the frontend can hand to xterm.write. */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const projectService = {
  list: () =>
    invokeOrThrow<ListResponse<Project>>(PROJECT_CMD.list).then((r) => r.items),
  validate: (input: ProjectInput) =>
    invokeOrThrow<void>(PROJECT_CMD.validate, { input }),
  create: (input: ProjectInput) =>
    invokeOrThrow<Project>(PROJECT_CMD.create, { input }),
  update: (input: ProjectInput) =>
    invokeOrThrow<Project>(PROJECT_CMD.update, { input }),
  delete: (id: string) => invokeOrThrow<void>(PROJECT_CMD.delete, { id }),
  openInExplorer: (id: string) =>
    invokeOrThrow<void>(PROJECT_CMD.explorer, { id }),
};

export const profileService = {
  list: (projectId: string) =>
    invokeOrThrow<ListResponse<TerminalProfile>>(PROFILE_CMD.list, {
      projectId,
    }).then((r) => r.items),
  validate: (input: ProfileInput) =>
    invokeOrThrow<void>(PROFILE_CMD.validate, { input }),
  create: (input: ProfileInput) =>
    invokeOrThrow<TerminalProfile>(PROFILE_CMD.create, { input }),
  update: (input: ProfileInput) =>
    invokeOrThrow<TerminalProfile>(PROFILE_CMD.update, { input }),
  delete: (id: string) => invokeOrThrow<void>(PROFILE_CMD.delete, { id }),
  duplicate: (id: string) =>
    invokeOrThrow<TerminalProfile>(PROFILE_CMD.duplicate, { id }),
  test: (id: string) => invokeOrThrow<string>(PROFILE_CMD.test, { id }),
};

export interface DetectedShell {
  shellType: TerminalProfile["shellType"];
  name: string;
  executable: string;
}

export interface DetectedPythonEnvironment {
  name: string;
  path: string;
  kind: "venv";
}

export const templateService = {
  list: () =>
    invokeOrThrow<ListResponse<ProfileTemplate>>(TEMPLATE_CMD.list).then(
      (r) => r.items,
    ),
  create: (input: TemplateInput) =>
    invokeOrThrow<ProfileTemplate>(TEMPLATE_CMD.create, { input }),
  update: (input: TemplateInput) =>
    invokeOrThrow<ProfileTemplate>(TEMPLATE_CMD.update, { input }),
  delete: (id: string) => invokeOrThrow<void>(TEMPLATE_CMD.delete, { id }),
  createFromTemplate: (templateId: string, projectId: string, name: string) =>
    invokeOrThrow<TerminalProfile>(TEMPLATE_CMD.createFromTemplate, {
      templateId,
      projectId,
      name,
    }),
};

export const sshService = {
  list: () =>
    invokeOrThrow<ListResponse<SshConnection>>(SSH_CMD.list).then(
      (r) => r.items,
    ),
  validate: (input: SshConnectionInput) =>
    invokeOrThrow<void>(SSH_CMD.validate, { input }),
  create: (input: SshConnectionInput) =>
    invokeOrThrow<SshConnection>(SSH_CMD.create, { input }),
  update: (input: SshConnectionInput) =>
    invokeOrThrow<SshConnection>(SSH_CMD.update, { input }),
  delete: (id: string) => invokeOrThrow<void>(SSH_CMD.delete, { id }),
  test: (id: string) => invokeOrThrow<string>(SSH_CMD.test, { id }),
  listDirectories: (connectionId: string, path: string) =>
    invokeOrThrow<RemoteDirectoryListing>(SSH_CMD.listDirectories, {
      connectionId,
      path,
    }),
  detect: () => invokeOrThrow<string | null>(SSH_CMD.detect),
  fingerprint: (id: string) =>
    invokeOrThrow<string>(SSH_CMD.fingerprint, { id }),
};

export const terminalService = {
  readClipboardText: () => invokeOrThrow<string>("read_clipboard_text"),
  create: (request: CreateTerminalRequest): Promise<string> =>
    invokeOrThrow<string>("create_terminal", { request }),
  attach: async (
    sessionId: string,
    clientId: string,
    onOutput: (chunk: TerminalOutputChunk) => void,
  ): Promise<SessionAttachment> => {
    const channel = new Channel<TerminalOutputChunk>();
    channel.onmessage = onOutput;
    return invokeOrThrow<SessionAttachment>("session_attach", {
      onOutput: channel,
      sessionId,
      clientId,
    });
  },
  detach: (sessionId: string, clientId: string) =>
    invokeOrThrow<void>("session_detach", { sessionId, clientId }),
  list: () =>
    invokeOrThrow<ListResponse<SessionInfo>>("session_list").then(
      (response) => response.items,
    ),
  get: (sessionId: string) =>
    invokeOrThrow<SessionInfo>("session_get", { sessionId }),
  write: (sessionId: string, data: string) =>
    invokeOrThrow<void>("write_terminal", { sessionId, data }),
  resize: (sessionId: string, rows: number, cols: number) =>
    invokeOrThrow<void>("resize_terminal", { sessionId, rows, cols }),
  close: (sessionId: string) =>
    invokeOrThrow<void>("close_terminal", { sessionId }),
  restart: (sessionId: string): Promise<string> =>
    invokeOrThrow<string>("restart_terminal", { sessionId }),
  decodeBase64,
};

export interface DetectedCondaEnvironment {
  name?: string;
  path: string;
  isActive: boolean;
  isBase: boolean;
}

export interface DetectedWslDistribution {
  name: string;
}

export const environmentService = {
  detectShells: () =>
    invokeOrThrow<DetectedShell[]>(PROFILE_CMD.detectShells),
  detectPython: (projectId: string) =>
    invokeOrThrow<DetectedPythonEnvironment[]>(PROFILE_CMD.detectPython, {
      projectId,
    }),
  detectConda: () => invokeOrThrow<string[]>("detect_conda_installations"),
  listConda: (condaExecutable: string) =>
    invokeOrThrow<DetectedCondaEnvironment[]>("list_conda_environments", {
      condaExecutable,
    }),
  detectWslDistributions: () =>
    invokeOrThrow<DetectedWslDistribution[]>("detect_wsl_distributions"),
};

export const platformService = {
  getPlatformInfo: () => invokeOrThrow<PlatformInfo>("get_platform_info"),
};

export const agentService = {
  listProfiles: () =>
    invokeOrThrow<ListResponse<AgentProfile>>("list_agent_profiles").then(
      (response) => response.items,
    ),
  createProfile: (input: AgentProfileInput) =>
    invokeOrThrow<AgentProfile>("create_agent_profile", { input }),
  updateProfile: (input: AgentProfileInput) =>
    invokeOrThrow<AgentProfile>("update_agent_profile", { input }),
  deleteProfile: (id: string) =>
    invokeOrThrow<void>("delete_agent_profile", { id }),
  listSessions: () =>
    invokeOrThrow<ListResponse<AgentSession>>("list_agent_sessions").then(
      (response) => response.items,
    ),
  listEvents: (agentSessionId: string) =>
    invokeOrThrow<ListResponse<AgentEvent>>("list_agent_events", {
      agentSessionId,
    }).then((response) => response.items),
  start: (agentProfileId: string) =>
    invokeOrThrow<AgentSession>("start_agent", { agentProfileId }),
  stop: (agentSessionId: string) =>
    invokeOrThrow<AgentSession>("stop_agent", { agentSessionId }),
  restart: (agentSessionId: string) =>
    invokeOrThrow<AgentSession>("restart_agent", { agentSessionId }),
  respond: (agentSessionId: string, input: string) =>
    invokeOrThrow<AgentSession>("respond_agent", { agentSessionId, input }),
  interrupt: (agentSessionId: string) =>
    invokeOrThrow<void>("interrupt_agent", { agentSessionId }),
};

export interface DaemonStatus {
  connected: boolean;
  endpoint: string;
  details?: { pid?: number; startedAt?: string };
  error?: string;
}

export const daemonService = {
  status: () => invokeOrThrow<DaemonStatus>("daemon_status"),
  reconnect: () => invokeOrThrow<DaemonStatus>("reconnect_daemon"),
  listSessions: () =>
    invokeOrThrow<{
      sessions: SessionInfo[];
      recoveredAsFailed: Array<
        SessionInfo & { exitReason?: string }
      >;
    }>("daemon_list_sessions"),
};

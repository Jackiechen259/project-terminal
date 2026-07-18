/**
 * Typed Tauri command bindings. These wrap `invoke()` calls and pin the
 * argument/return shapes. The frontend never sends raw commands - only the
 * domain-specific payloads defined here.
 */

import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";

import type { Project, SshConnection, TerminalProfile } from "@/types";

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
} as const;

const PROFILE_CMD = {
  list: "list_terminal_profiles",
  validate: "validate_terminal_profile",
  create: "create_terminal_profile",
  update: "update_terminal_profile",
  delete: "delete_terminal_profile",
  test: "test_terminal_profile",
} as const;

const SSH_CMD = {
  list: "list_ssh_connections",
  validate: "validate_ssh_connection",
  create: "create_ssh_connection",
  update: "update_ssh_connection",
  delete: "delete_ssh_connection",
  test: "test_ssh_connection",
  detect: "detect_ssh_client",
  fingerprint: "read_ssh_host_fingerprint",
} as const;

export interface ProjectInput {
  id?: string;
  name: string;
  type: "local" | "ssh";
  local?: { path: string };
  ssh?: { connectionId: string; remotePath: string };
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

export interface CreateTerminalRequest {
  projectId: string;
  profileId: string;
  rows: number;
  cols: number;
}

export interface TerminalOutputChunk {
  sessionId: string;
  /** base64-encoded bytes from the PTY. */
  data: string;
}

export interface TerminalSessionStatus {
  status: "starting" | "running" | "exited" | "error";
  exitCode?: number;
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
  test: (id: string) => invokeOrThrow<string>(PROFILE_CMD.test, { id }),
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
  detect: () => invokeOrThrow<string | null>(SSH_CMD.detect),
  fingerprint: (id: string) =>
    invokeOrThrow<string>(SSH_CMD.fingerprint, { id }),
};

export const terminalService = {
  create: async (
    request: CreateTerminalRequest,
    onOutput: (chunk: TerminalOutputChunk) => void,
  ): Promise<string> => {
    const channel = new Channel<TerminalOutputChunk>();
    channel.onmessage = onOutput;
    return invokeOrThrow<string>("create_terminal", {
      onOutput: channel,
      request,
    });
  },
  write: (sessionId: string, data: string) =>
    invokeOrThrow<void>("write_terminal", { sessionId, data }),
  resize: (sessionId: string, rows: number, cols: number) =>
    invokeOrThrow<void>("resize_terminal", { sessionId, rows, cols }),
  status: (sessionId: string) =>
    invokeOrThrow<TerminalSessionStatus>("terminal_session_status", {
      sessionId,
    }),
  close: (sessionId: string) =>
    invokeOrThrow<void>("close_terminal", { sessionId }),
  restart: async (
    sessionId: string,
    onOutput: (chunk: TerminalOutputChunk) => void,
  ): Promise<string> => {
    const channel = new Channel<TerminalOutputChunk>();
    channel.onmessage = onOutput;
    return invokeOrThrow<string>("restart_terminal", {
      onOutput: channel,
      sessionId,
    });
  },
  decodeBase64,
};

export interface DetectedCondaEnvironment {
  name?: string;
  path: string;
  isActive: boolean;
  isBase: boolean;
}

export const environmentService = {
  detectConda: () => invokeOrThrow<string[]>("detect_conda_installations"),
  listConda: (condaExecutable: string) =>
    invokeOrThrow<DetectedCondaEnvironment[]>("list_conda_environments", {
      condaExecutable,
    }),
};

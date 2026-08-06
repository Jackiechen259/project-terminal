/**
 * Typed Tauri command bindings. These wrap `invoke()` calls and pin the
 * argument/return shapes. The frontend never sends raw commands - only the
 * domain-specific payloads defined here.
 */

import { Channel, invoke as tauriInvoke } from "@tauri-apps/api/core";

import type { TerminalSessionFrame } from "@/lib/terminalFrames";
import type {
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
  delete: "delete_project_workspace",
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
  scanWindowsTerminal: "scan_windows_terminal_profiles",
  importWindowsTerminal: "import_windows_terminal_profiles",
  detectShells: "detect_local_shells",
  detectPython: "detect_python_environments",
} as const;

const TEMPLATE_CMD = {
  list: "list_profile_templates",
  create: "create_profile_template",
  update: "update_profile_template",
  delete: "delete_profile_template",
  createFromTemplate: "create_profile_from_template",
  scanWindowsTerminal: "scan_windows_terminal_templates",
  importWindowsTerminal: "import_windows_terminal_templates",
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

const FILE_CMD = {
  list: "list_project_files",
  upload: "upload_project_files",
  download: "download_project_file",
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
  forceUtf8?: boolean;
  shellIntegration?: boolean;
  /** Terminal colour scheme for this profile, overriding the global choice. */
  colorSchemeId?: string;
  /** Tab and focused-pane accent, `#rrggbb`. */
  accentColor?: string;
  isDefault: boolean;
  showInContextMenu: boolean;
}

export interface WindowsTerminalImportResult {
  imported: TerminalProfile[];
  skippedCount: number;
  sourceFiles: string[];
}

export interface WindowsTerminalTemplateImportResult {
  imported: ProfileTemplate[];
  skippedCount: number;
  sourceFiles: string[];
}

/** One selectable entry in the Windows Terminal import picker. */
export interface WindowsTerminalCandidate {
  /** Launch-configuration signature; also the de-duplication key. */
  key: string;
  name: string;
  shellType: TerminalProfile["shellType"];
  shellExecutable?: string;
  shellArgs?: string[];
  wslDistribution?: string;
  wslWorkingDirectory?: string;
  environmentVariables?: Record<string, string>;
  isWindowsTerminalDefault: boolean;
  /** The destination already holds this launch configuration. */
  alreadyExists: boolean;
}

export interface WindowsTerminalScanResult {
  candidates: WindowsTerminalCandidate[];
  skippedCount: number;
  sourceFiles: string[];
}

/**
 * A colour scheme the user imported, as stored by the backend.
 *
 * Flat rather than an xterm `ITheme` because that is the shape both Windows
 * Terminal and the on-disk file use; `toTerminalColorScheme` reshapes it.
 */
export interface StoredColorScheme {
  id: string;
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent?: string;
  selectionBackground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  createdAt: string;
  updatedAt: string;
}

export interface WindowsTerminalSchemeCandidate {
  key: string;
  name: string;
  background: string;
  foreground: string;
  /** The sixteen ANSI colours in order, for the picker's swatch strip. */
  ansi: string[];
  alreadyExists: boolean;
}

export interface WindowsTerminalSchemeScanResult {
  candidates: WindowsTerminalSchemeCandidate[];
  skippedCount: number;
  sourceFiles: string[];
}

export interface WindowsTerminalSchemeImportResult {
  imported: StoredColorScheme[];
  skippedCount: number;
  sourceFiles: string[];
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
  forceUtf8?: boolean;
  shellIntegration?: boolean;
  /** Terminal colour scheme for this profile, overriding the global choice. */
  colorSchemeId?: string;
  /** Tab and focused-pane accent, `#rrggbb`. */
  accentColor?: string;
}

export interface SshConnectionInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authenticationType: SshConnection["authenticationType"];
  /** Write-only. Never returned by the backend. */
  password?: string;
  clearSavedPassword?: boolean;
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
  scrollbackMegabytes?: number;
}

export type {
  TerminalControlFrame,
  TerminalSessionFrame,
} from "@/lib/terminalFrames";

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
  scrollback?: string;
  /** Output and historical grid changes in their original order. */
  replay?: Array<
    | { type: "output"; data: string }
    | { type: "resize"; rows: number; cols: number }
  >;
  truncated: boolean;
}

export interface RemoteDirectoryListing {
  path: string;
  directories: Array<{ name: string; path: string }>;
}

export interface ProjectFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
}

export interface ProjectFileListing {
  rootPath: string;
  path: string;
  parentPath?: string;
  entries: ProjectFileEntry[];
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

/**
 * Decode a base64 string into bytes the frontend can hand to xterm.write.
 *
 * Only attach replay still travels as base64; live output crosses the IPC
 * boundary as raw bytes. WebView2 has no `Uint8Array.fromBase64` yet, so the
 * per-byte fallback is the live path today and the native branch takes over
 * for free once it ships.
 */
function decodeBase64(b64: string): Uint8Array {
  const nativeDecoder = (
    Uint8Array as typeof Uint8Array & {
      fromBase64?: (value: string) => Uint8Array;
    }
  ).fromBase64;
  if (nativeDecoder) {
    return nativeDecoder.call(Uint8Array, b64);
  }

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
  scanWindowsTerminal: (projectId: string) =>
    invokeOrThrow<WindowsTerminalScanResult>(PROFILE_CMD.scanWindowsTerminal, {
      projectId,
    }),
  importWindowsTerminal: (projectId: string, keys: string[]) =>
    invokeOrThrow<WindowsTerminalImportResult>(
      PROFILE_CMD.importWindowsTerminal,
      { projectId, keys },
    ),
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

/**
 * Colour schemes the user imported. Built-in schemes are frontend code
 * (`@/lib/terminalColorSchemes`) and never cross this boundary.
 */
export const colorSchemeService = {
  list: () =>
    invokeOrThrow<ListResponse<StoredColorScheme>>("list_color_schemes").then(
      (r) => r.items,
    ),
  delete: (id: string) => invokeOrThrow<void>("delete_color_scheme", { id }),
  importFromFile: (path: string) =>
    invokeOrThrow<ListResponse<StoredColorScheme>>(
      "import_color_schemes_from_file",
      { path },
    ).then((r) => r.items),
  scanWindowsTerminal: () =>
    invokeOrThrow<WindowsTerminalSchemeScanResult>(
      "scan_windows_terminal_color_schemes",
    ),
  importWindowsTerminal: (keys: string[]) =>
    invokeOrThrow<WindowsTerminalSchemeImportResult>(
      "import_windows_terminal_color_schemes",
      { keys },
    ),
};

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
  scanWindowsTerminal: () =>
    invokeOrThrow<WindowsTerminalScanResult>(TEMPLATE_CMD.scanWindowsTerminal),
  importWindowsTerminal: (keys: string[]) =>
    invokeOrThrow<WindowsTerminalTemplateImportResult>(
      TEMPLATE_CMD.importWindowsTerminal,
      { keys },
    ),
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

export const fileService = {
  list: (projectId: string, path?: string) =>
    invokeOrThrow<ProjectFileListing>(FILE_CMD.list, { projectId, path }),
  upload: (projectId: string, destinationPath: string, sourcePaths: string[]) =>
    invokeOrThrow<void>(FILE_CMD.upload, {
      projectId,
      destinationPath,
      sourcePaths,
    }),
  download: (
    projectId: string,
    sourcePath: string,
    destinationDirectory: string,
    isDirectory: boolean,
  ) =>
    invokeOrThrow<void>(FILE_CMD.download, {
      projectId,
      sourcePath,
      destinationDirectory,
      isDirectory,
    }),
};

export const terminalService = {
  readClipboardText: () => invokeOrThrow<string>("read_clipboard_text"),
  create: (request: CreateTerminalRequest): Promise<string> =>
    invokeOrThrow<string>("create_terminal", { request }),
  attach: async (
    sessionId: string,
    clientId: string,
    onFrame: (frame: TerminalSessionFrame) => void,
  ): Promise<SessionAttachment> => {
    const channel = new Channel<TerminalSessionFrame>();
    channel.onmessage = onFrame;
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
  // xterm's `onBinary` payload is not text; it must not be UTF-8 encoded.
  writeBinary: (sessionId: string, data: Uint8Array) =>
    invokeOrThrow<void>("write_terminal_binary", {
      sessionId,
      data: Array.from(data),
    }),
  resize: (
    sessionId: string,
    rows: number,
    cols: number,
    pixelWidth = 0,
    pixelHeight = 0,
  ) =>
    invokeOrThrow<void>("resize_terminal", {
      sessionId,
      rows,
      cols,
      pixelWidth,
      pixelHeight,
    }),
  close: (sessionId: string) =>
    invokeOrThrow<void>("close_terminal", { sessionId }),
  restart: (sessionId: string): Promise<string> =>
    invokeOrThrow<string>("restart_terminal", { sessionId }),
  decodeBase64,
  /**
   * Open a link from terminal output in the user's browser. The backend
   * re-validates the scheme; never navigate the WebView to it.
   */
  openExternalUrl: (url: string) =>
    invokeOrThrow<void>("open_external_url", { url }),
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
  detectShells: () => invokeOrThrow<DetectedShell[]>(PROFILE_CMD.detectShells),
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

export interface RemoteAccessInfo {
  enabled: boolean;
  bind: string;
  url: string;
  token: string;
  transportSecurity: "loopback" | "tailscale" | "tls-terminated" | "lan";
  allowLan: boolean;
}

export const remoteAccessService = {
  remoteAccessInfo: () => invokeOrThrow<RemoteAccessInfo>("remote_access_info"),
  setRemoteLanAccess: (allowLan: boolean) =>
    invokeOrThrow<RemoteAccessInfo>("set_remote_lan_access", { allowLan }),
  setRemoteEnabled: (enabled: boolean) =>
    invokeOrThrow<RemoteAccessInfo>("set_remote_enabled", { enabled }),
};

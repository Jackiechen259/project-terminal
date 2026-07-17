# Project Terminal

> Status: Phase 1 + Phase 2 complete. The app shell renders; project models and JSON repositories with atomic writes, project/profile/SSH connection CRUD commands, project sidebar with add dialog, and Zustand stores (project, profile, terminal, ssh) are wired. Phase 3 will add the PTY terminal backend. Later phases add profiles, environments, SSH remote terminals, and packaging.

## Features (planned)

- Local folder projects and SSH remote projects.
- Per-project terminal tab groups with independent PTY/shell/environment.
- Shells: PowerShell, CMD, Git Bash, WSL, custom.
- Environments: none, Conda, Python venv, Poetry, uv, custom.
- Saved terminal profiles, SSH connection configs, and UI preferences.
- SSH remote terminals via the system OpenSSH client (`ssh.exe`) running inside a local PTY.
- JSON config persistence under `%APPDATA%\ProjectTerminal\`.

See [`project-terminal-agent-plan.md`](./project-terminal-agent-plan.md) for the full design.

## Tech stack

- **Desktop:** Tauri 2, Rust, Windows-first.
- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, Zustand, Lucide.
- **Terminal:** `@xterm/xterm` + `@xterm/addon-fit` in the frontend; Rust `portable-pty` for the PTY backend.
- **Data:** JSON files (no database in MVP).
- **SSH:** System `ssh.exe` (Windows OpenSSH), never an in-app SSH protocol stack.

## Prerequisites

- Windows 10/11 x64.
- [Node.js](https://nodejs.org/) 20+ (LTS recommended).
- [pnpm](https://pnpm.io/) 9+ (`npm i -g pnpm`).
- [Rust](https://www.rust-lang.org/tools/install) stable (1.77+).
- Windows OpenSSH client (`ssh.exe`) — default on Windows 10 1809+ at `%WINDIR%\System32\OpenSSH\ssh.exe`. Verify with `where ssh.exe`.
- WebView2 runtime (preinstalled on Windows 11; install via the Microsoft Edge WebView2 installer on Windows 10).
- Microsoft C++ Build Tools (for the Rust toolchain — bundled with "Desktop development with C++" in Visual Studio Build Tools).

## Install dependencies

```powershell
pnpm install
```

## Development

Run the Vite dev server and the Tauri shell together:

```powershell
pnpm tauri dev
```

Frontend-only dev server (faster iteration, no Rust rebuild):

```powershell
pnpm dev
```

## Build / package

```powershell
pnpm tauri build
```

Outputs a Windows MSI and NSIS installer under `src-tauri/target/release/bundle/`.

## Scripts

| Script              | Description                                  |
| ------------------- | -------------------------------------------- |
| `pnpm dev`          | Vite dev server only                         |
| `pnpm build`        | TypeScript check + Vite production build    |
| `pnpm tauri:dev`    | Tauri dev shell (Vite + Rust)               |
| `pnpm tauri:build`  | Tauri production build + installers         |
| `pnpm test`         | Run Vitest unit tests                        |
| `pnpm test:watch`   | Watch Vitest                                 |
| `pnpm lint`         | ESLint flat config                           |
| `pnpm format`       | Prettier write                               |
| `pnpm format:check` | Prettier check                               |

For Rust:

```powershell
cargo fmt   --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo test  --manifest-path src-tauri/Cargo.toml
```

## Directory structure

```text
project-terminal/
├─ src/                       # React + TypeScript frontend
│  ├─ components/
│  │  ├─ layout/              # AppLayout, TitleBar
│  │  ├─ projects/            # Sidebar, project dialogs
│  │  ├─ profiles/            # Terminal profile dialogs
│  │  ├─ ssh/                 # SSH connection dialogs
│  │  ├─ terminal/            # Tabs, terminal view, workspace
│  │  └─ common/              # ErrorBanner, ConfirmDialog, LoadingState
│  ├─ stores/                 # Zustand stores
│  ├─ services/               # Tauri command bindings
│  ├─ types/                  # Domain types
│  ├─ lib/                    # Shared utilities
│  ├─ App.tsx
│  └─ main.tsx
├─ src-tauri/
│  ├─ src/
│  │  ├─ commands/            # Tauri command modules
│  │  ├─ project/             # Project model + JSON repository
│  │  ├─ profile/             # Terminal profile model + repository
│  │  ├─ ssh/                 # SSH model, command builder, host key
│  │  ├─ terminal/            # TerminalManager, session, initializer
│  │  ├─ environment/         # Conda, venv, poetry, uv resolvers
│  │  ├─ error.rs
│  │  ├─ state.rs
│  │  ├─ lib.rs
│  │  └─ main.rs
│  ├─ capabilities/default.json
│  ├─ Cargo.toml
│  └─ tauri.conf.json
├─ package.json
└─ README.md
```

## Architecture (summary)

### PTY

Each terminal tab owns an independent PTY allocated by Rust `portable-pty`. The frontend never receives or sends raw shell commands; it only forwards bytes through `write_terminal` and receives output bytes through a Tauri `Channel` keyed by `sessionId`.

### Project tab group

Tabs are stored as `tabsById: Record<id, TerminalTab>` plus `tabGroupsByProjectId: Record<projectId, ProjectTabGroup>`. Switching projects only changes visibility — `TerminalView` components stay mounted and PTY readers keep running.

### Terminal profile

Profiles are first-class models belonging to a project. The backend resolves the shell executable, environment activation, startup commands, and environment variables from the saved profile; the frontend only submits `projectId` and `profileId` when creating a terminal.

### Conda initialization

Conda is activated per-session via the appropriate shell hook (`conda-hook.ps1` for PowerShell, `conda.bat` for CMD, `etc/profile.d/conda.sh` for bash/zsh). The application never calls `conda init` or modifies the global environment — every activation is scoped to a single PTY session.

### SSH security

- Uses the system `ssh.exe` inside a local PTY.
- Host key verification is **on by default**. Unknown or changed host keys block the connection; the user must explicitly confirm a new fingerprint.
- Passwords are never persisted — they are typed into the PTY at the `ssh.exe` prompt and not intercepted or logged.
- Private key file paths are stored, not key contents.
- The system `ssh-agent` is the recommended authentication method.
- ProxyJump (`-J`) is supported for a single jump host.

## Configuration files

Stored under `%APPDATA%\ProjectTerminal\`:

```text
projects.json        # Saved projects
profiles.json        # Saved terminal profiles
ssh-connections.json # Saved SSH connection configs
settings.json        # UI preferences
```

Writes are atomic: serialize → temp file → flush → rename. Corrupt files are backed up with a timestamp, not overwritten.

## Security model

- No arbitrary command execution API. The only terminal-creation inputs are `projectId` and `profileId`.
- Shell executable, working directory, environment variables, and SSH arguments are resolved on the Rust side from saved, validated configuration.
- Shell and SSH arguments are passed as arrays — never concatenated strings.
- SSH host key checking cannot be silently disabled.
- Terminal input is forwarded byte-for-byte; it is never parsed or logged.
- Tauri capabilities are limited to the minimum required (no shell plugin, no filesystem plugin, no arbitrary process spawn).

## Known limitations (MVP)

- No AI command suggestions, split panes, cloud sync, file manager, built-in editor, SFTP UI, port-forwarding UI, Git GUI, multi-window, or plugin system.
- Running sessions are not restored across application restarts.
- Terminal output is not persisted.
- The application does not create, modify, or install Conda/venv/poetry/uv environments.
- The application does not auto-accept unknown SSH host keys.

## Roadmap

See `project-terminal-agent-plan.md` §37 for the phase breakdown. Current phases: **Phase 1 (skeleton) + Phase 2 (project + config persistence, CRUD, stores) complete; Phase 3 (single local PTY terminal) next.**

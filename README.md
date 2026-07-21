<div align="center">

# Project Terminal

**A project-oriented desktop terminal for local, WSL, and remote development.**

Keep every project's terminal tabs, shell profiles, environments, and SSH sessions together in one workspace.

[![Release](https://img.shields.io/github/v/release/Jackiechen259/project-terminal?display_name=tag&sort=semver)](https://github.com/Jackiechen259/project-terminal/releases/latest)
[![License](https://img.shields.io/github/license/Jackiechen259/project-terminal)](./LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)

[Download](#download) · [Features](#features) · [Development](#development) · [Architecture](#architecture) · [Security](#security)

</div>

## Overview

Project Terminal is a Windows-first desktop terminal workspace for developers who regularly move between different codebases, shells, virtual environments, WSL distributions, and remote servers.

Instead of keeping unrelated sessions in one global tab bar, Project Terminal organizes terminals by **project**. Each project owns its own tab group and terminal profiles. Switching projects changes the visible workspace without destroying running PTY sessions.

The current release is **v0.2.0**.

## Features

- **Project-scoped workspaces** — each project has an independent terminal tab group.
- **Local projects** — open a terminal directly in a Windows folder.
- **WSL projects** — select a distribution and start in a Linux working directory.
- **SSH projects** — connect to remote machines and enter the configured remote path.
- **Persistent sessions while switching projects** — hidden terminal views remain mounted and active.
- **Reusable terminal profiles** — save shell, environment, startup command, arguments, and environment-variable settings.
- **Multiple shell types** — PowerShell, CMD, Git Bash, WSL, remote Bash/Zsh/Fish, and custom executables.
- **Development environment activation** — Conda, Python venv, Poetry, uv, or a custom activation command.
- **Interactive SSH authentication** — password, keyboard-interactive, and private-key passphrase prompts stay inside the terminal.
- **Safe local persistence** — project settings are stored as atomic JSON files instead of requiring a database.
- **Signed update support** — packaged builds can check GitHub Releases for newer versions.

## Project types

| Type | Purpose | Working directory |
| --- | --- | --- |
| **Local** | Native Windows development | A Windows folder such as `D:\Projects\app` |
| **WSL** | Development inside a WSL distribution | A Linux path such as `/home/user/app` |
| **SSH** | Development on a remote server | A remote path such as `/srv/app` |

Each project can contain multiple terminal profiles. For example, one local project can have separate profiles for PowerShell, Git Bash, a Conda environment, and a custom toolchain.

## Supported shells and environments

### Shells

- PowerShell
- Command Prompt
- Git Bash
- WSL
- Remote default shell
- Remote Bash
- Remote Zsh
- Remote Fish
- Custom shell executable

### Environments

- None
- Conda
- Python virtual environment
- Poetry
- uv
- Custom activation command

Environment initialization is scoped to the terminal session. Project Terminal does not run `conda init`, `poetry shell`, or `uv sync`, and it does not modify the user's global shell configuration.

## Download

Download the latest installers and packages from the [GitHub Releases page](https://github.com/Jackiechen259/project-terminal/releases/latest).

Release builds currently include:

- Windows NSIS installer
- Windows MSI installer
- Linux AppImage
- Linux `.deb` package
- Linux `.rpm` package

> Project Terminal is developed primarily for Windows. Linux packages are published by the release workflow, but Windows remains the main supported desktop environment.

### Windows runtime requirements

- Windows 10 or Windows 11 x64
- Microsoft Edge WebView2 Runtime
- Windows OpenSSH Client for SSH projects
- WSL installed and configured for WSL projects

To verify OpenSSH and WSL:

```powershell
where.exe ssh.exe
wsl.exe --list --verbose
```

## Getting started

1. Install and launch Project Terminal.
2. Create a **Local**, **WSL**, or **SSH** project.
3. Add or edit a terminal profile for that project.
4. Choose the shell and optional development environment.
5. Open a terminal tab.
6. Switch between projects from the sidebar; existing sessions remain active.

### SSH projects

Project Terminal uses the system OpenSSH client instead of implementing a separate SSH protocol stack.

Before creating an SSH project, confirm that the target is reachable from a normal terminal:

```powershell
ssh user@example.com
```

For key-based authentication, using `ssh-agent` is recommended. Project Terminal stores private-key **paths**, never private-key contents or SSH passwords.

## Configuration

Application data is stored under:

```text
%APPDATA%\ProjectTerminal\
```

Files include:

```text
projects.json         Saved local, WSL, and SSH projects
profiles.json         Terminal profiles and environment settings
ssh-connections.json  SSH connection definitions
settings.json         Application preferences
```

Writes are atomic: data is serialized to a temporary file, flushed, and then renamed. When a corrupt configuration file is detected, it is backed up with a timestamp rather than silently overwritten.

## Architecture

```text
React / TypeScript UI
        │
        │ Tauri commands and channels
        ▼
Rust application backend
        │
        ├── Project, profile, SSH, and settings repositories
        ├── Shell and environment resolution
        ├── Terminal session manager
        └── portable-pty
                │
                ├── PowerShell / CMD / Git Bash
                ├── WSL
                └── system OpenSSH client
```

### Terminal sessions

Every terminal tab owns an independent PTY created by Rust through `portable-pty`. The frontend sends input bytes to the backend and receives terminal output through a Tauri channel associated with the session ID.

### Project tab groups

Tabs are grouped by project. Switching projects changes which group is visible, but terminal components remain mounted, so background processes and remote sessions continue running.

### Terminal profiles

Profiles are stored as first-class project resources. The Rust backend resolves the executable, arguments, working directory, environment activation, startup commands, and environment variables from saved configuration.

### Remote initialization

For an SSH project, Project Terminal first establishes the interactive SSH session, enters the configured remote directory, and then runs the selected remote initialization commands. If initialization fails, the error is shown while leaving the remote shell usable.

## Security

- SSH connections use the system `ssh` executable.
- Host-key verification is enabled by default.
- Unknown host keys require explicit confirmation.
- Changed host keys block the connection instead of being silently accepted.
- Passwords and passphrases are entered directly into the PTY and are not persisted or logged.
- Private-key contents are never stored by the application.
- Shell and SSH arguments are passed as argument arrays, not concatenated command strings.
- Terminal input is forwarded byte-for-byte and is not parsed or recorded.
- Tauri capabilities are restricted to the functionality required by the application.
- Configuration writes are atomic and corrupt files are preserved for recovery.

## Tech stack

| Layer | Technology |
| --- | --- |
| Desktop shell | Tauri 2 |
| Backend | Rust |
| Frontend | React 18, TypeScript, Vite |
| UI | Tailwind CSS, Radix UI, shadcn/ui, Lucide |
| State management | Zustand |
| Terminal renderer | xterm.js |
| PTY backend | portable-pty |
| Persistence | JSON files |
| SSH | System OpenSSH client |
| Testing | Vitest and Rust tests |

## Development

### Prerequisites

- Node.js 20 or newer
- pnpm 9 or newer
- Rust stable toolchain
- Microsoft C++ Build Tools with **Desktop development with C++** on Windows
- WebView2 Runtime on Windows
- Windows OpenSSH Client for testing SSH projects
- WSL for testing WSL projects

### Install dependencies

```powershell
git clone https://github.com/Jackiechen259/project-terminal.git
cd project-terminal
pnpm install
```

### Run the desktop application

```powershell
pnpm tauri:dev
```

### Run only the frontend

```powershell
pnpm dev
```

Frontend-only mode is useful for UI development, but PTY, filesystem persistence, SSH, and other native Tauri features require the desktop application.

### Build installers

```powershell
pnpm tauri:build
```

Windows bundles are generated under:

```text
src-tauri/target/release/bundle/
```

## Available scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the Vite development server |
| `pnpm build` | Type-check and build the frontend |
| `pnpm tauri:dev` | Start the Tauri desktop app in development mode |
| `pnpm tauri:build` | Build the desktop application and installers |
| `pnpm test` | Run frontend unit tests |
| `pnpm test:watch` | Run Vitest in watch mode |
| `pnpm lint` | Run ESLint |
| `pnpm format` | Format frontend files with Prettier |
| `pnpm format:check` | Check frontend formatting |

Rust checks:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

## Repository structure

```text
project-terminal/
├── src/                         React and TypeScript frontend
│   ├── components/
│   │   ├── common/              Shared feedback and dialog components
│   │   ├── layout/              Main layout and custom title bar
│   │   ├── profiles/            Terminal profile UI
│   │   ├── projects/            Project sidebar and project dialogs
│   │   ├── ssh/                 SSH connection UI
│   │   └── terminal/            Terminal tabs, views, and workspace
│   ├── services/                Tauri command bindings
│   ├── stores/                  Zustand stores
│   ├── types/                   Frontend domain types
│   └── lib/                     Shared utilities
├── src-tauri/
│   ├── src/
│   │   ├── commands/            Tauri command handlers
│   │   ├── environment/         Environment activation and resolution
│   │   ├── profile/             Terminal profile model and persistence
│   │   ├── project/             Project model and persistence
│   │   ├── ssh/                 SSH configuration and command building
│   │   └── terminal/            PTY sessions and terminal management
│   ├── capabilities/            Tauri permission configuration
│   ├── Cargo.toml
│   └── tauri.conf.json
├── .github/workflows/release.yml
├── package.json
└── README.md
```

## Release process

The GitHub Actions release workflow runs when a tag beginning with `v` is pushed.

Before publishing a release, keep these versions identical:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Then create and push the matching tag:

```powershell
git tag v0.2.0
git push origin v0.2.0
```

The workflow builds Windows and Linux packages, signs updater artifacts, creates the GitHub Release, and publishes update metadata.

The repository must contain the Actions secret `TAURI_SIGNING_PRIVATE_KEY`. The private signing key must never be committed. Keep a secure backup because installed applications trust the matching public key embedded in the Tauri configuration.

## Known limitations

- Running terminal sessions are not restored after restarting the application.
- Terminal output history is not persisted to disk.
- Unknown SSH host keys are never accepted automatically.
- Split panes are not currently available.
- There is no built-in file manager, editor, SFTP browser, Git GUI, or port-forwarding UI.
- There is no cloud synchronization or multi-device profile synchronization.
- The application currently uses a single main window.

## Roadmap

Potential future work includes:

- Session restoration
- Split terminal panes
- Searchable terminal history
- Port-forwarding management
- SFTP and remote file browsing
- Project import and export
- Optional synchronized configuration
- Additional terminal customization

The detailed original implementation plan is available in [`project-terminal-agent-plan.md`](./project-terminal-agent-plan.md).

## Contributing

Issues and pull requests are welcome. For substantial changes, open an issue first to discuss the proposed behavior and its impact on the project, terminal, and security models.

Before submitting a pull request, run:

```powershell
pnpm lint
pnpm format:check
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
```

## License

Licensed under the [Apache License 2.0](./LICENSE).
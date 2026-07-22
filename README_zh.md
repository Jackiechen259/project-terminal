<div align="center">

# Project Terminal

**面向本地、WSL 与远程开发的项目导向型桌面终端工具。**

在同一个工作区中，将每个项目的终端标签页、Shell 配置、开发环境以及 SSH 会话集中管理。

[![Release](https://img.shields.io/github/v/release/Jackiechen259/project-terminal?display_name=tag&sort=semver)](https://github.com/Jackiechen259/project-terminal/releases/latest)
[![License](https://img.shields.io/github/license/Jackiechen259/project-terminal)](./LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white)](https://www.rust-lang.org/)

[简体中文](./README_zh.md) · [English](./README.md)

[下载](#下载) · [功能特性](#功能特性) · [快速开始](#快速开始) · [架构设计](#架构设计) · [安全特性](#安全特性)

</div>

## 概述

Project Terminal 是一款以 Windows 为优先支持平台的桌面终端工作区，专为需要在不同代码库、Shell、虚拟环境、WSL 分发版及远程服务器之间频繁切换的开发者打造。

Project Terminal 并没有将无关会话混杂在全局标签栏中，而是按**项目 (Project)** 来组织终端。每个项目都拥有独立的终端标签页组与终端配置 (Profiles)。切换项目只会改变当前可见的工作区，而不会中断后台正在运行的 PTY 会话。

## 功能特性

- **项目作用域工作区** — 每个项目都拥有独立的终端标签页组。
- **本地项目 (Local)** — 直接在 Windows 本地文件夹中打开终端。
- **WSL 项目** — 选择指定 WSL 分发版并在 Linux 工作目录中启动。
- **SSH 项目** — 连接远程服务器并自动进入配置的远程路径。
- **项目切换会话持久化** — 隐藏的终端视图保持挂载与后台活跃运行状态。
- **可复用的终端配置 (Profiles)** — 保存 Shell、环境变量、启动命令、自定义参数与环境变量配置。
- **多种 Shell 类型** — 支持 PowerShell、CMD、Git Bash、WSL、远程 Bash/Zsh/Fish 以及自定义可执行文件。
- **开发环境自动激活** — 支持 Conda、Python venv、Poetry、uv 或自定义激活命令。
- **交互式 SSH 身份验证** — 密码、键盘交互 (keyboard-interactive) 以及私钥口令 (passphrase) 提示均在终端内完成。
- **安全的本地持久化存储** — 项目设置保存为原子化 JSON 文件，无需任何数据库依赖。
- **签名自动更新** — 打包版支持检查 GitHub Releases 获取最新版本。

## 项目类型

| 类型 | 用途 | 工作目录 |
| --- | --- | --- |
| **Local (本地)** | 原生 Windows 开发 | Windows 路径，例如 `D:\Projects\app` |
| **WSL** | WSL 分发版内开发 | Linux 路径，例如 `/home/user/app` |
| **SSH** | 远程服务器开发 | 远程路径，例如 `/srv/app` |

每个项目均可包含多个终端配置 (Profile)。例如，一个本地项目可以同时配置针对 PowerShell、Git Bash、Conda 环境和自定义工具链的独立 Profile。

## 支持的 Shell 与开发环境

### Shell

- PowerShell
- Command Prompt (CMD)
- Git Bash
- WSL
- 远程默认 Shell
- 远程 Bash
- 远程 Zsh
- 远程 Fish
- 自定义 Shell 可执行文件

### 开发环境 (Environments)

- 无 (None)
- Conda
- Python 虚拟环境 (venv)
- Poetry
- uv
- 自定义激活命令 (Custom activation command)

开发环境的初始化仅作用于该终端会话内部。Project Terminal **不会**在全局运行 `conda init`、`poetry shell` 或 `uv sync`，也不会修改用户的系统全局 Shell 配置。

## 下载

访问 [GitHub Releases 页面](https://github.com/Jackiechen259/project-terminal/releases/latest) 下载最新版本的安装包。

当前 Release 构建包含：

- Windows NSIS 安装程序 (`.exe`)
- Windows MSI 安装程序 (`.msi`)
- Linux AppImage
- Linux `.deb` 安装包
- Linux `.rpm` 安装包

> Project Terminal 主要针对 Windows 平台进行开发与测试。虽然发布工作流会自动构建 Linux 安装包，但 Windows 仍为主要支持的桌面环境。

### Windows 运行环境要求

- Windows 10 或 Windows 11 x64
- Microsoft Edge WebView2 Runtime
- 用于 SSH 项目的 Windows OpenSSH Client
- 用于 WSL 项目的 WSL 环境

验证 OpenSSH 和 WSL 是否已安装：

```powershell
where.exe ssh.exe
wsl.exe --list --verbose
```

## 快速开始

1. 安装并启动 Project Terminal。
2. 创建一个 **Local**、**WSL** 或 **SSH** 项目。
3. 为该项目添加或编辑终端配置 (Profile)。
4. 选择 Shell 及可选的开发环境。
5. 打开终端标签页。
6. 在侧边栏中随时切换不同项目；已打开的终端会话将保持后台活跃。

### SSH 项目配置

Project Terminal 使用系统内置的 OpenSSH 客户端，而非自行实现独立的 SSH 协议栈。

在创建 SSH 项目前，请先确保能够在终端中直接连通目标主机：

```powershell
ssh user@example.com
```

对于基于密钥的身份验证，建议配合使用 `ssh-agent`。Project Terminal 仅保存私钥**路径**，绝不保存私钥内容或 SSH 密码。

## 配置文件与路径

应用数据存储于以下路径：

```text
%APPDATA%\ProjectTerminal\
```

主要配置文件包括：

```text
projects.json         已保存的本地、WSL 及 SSH 项目
profiles.json         终端配置 (Profile) 与环境设置
ssh-connections.json  SSH 连接配置
settings.json         应用偏好设置
```

配置写入采用原子化写入机制：数据首先写入临时文件，刷新刷盘后再重命名覆盖。若检测到配置文件损坏，应用会将其带时间戳进行备份，而不会直接覆盖破坏数据。

## 架构设计

```text
React / TypeScript UI 前端
        │
        │ Tauri 命令与通道 (Channels)
        ▼
Rust 应用后端
        │
        ├── 项目 (Project)、配置 (Profile)、SSH 与设置存储仓 (Repositories)
        ├── Shell 与开发环境解析器
        ├── 终端会话管理器 (Terminal session manager)
        └── portable-pty
                │
                ├── PowerShell / CMD / Git Bash
                ├── WSL
                └── 系统内置 OpenSSH 客户端
```

### 终端会话 (Terminal Sessions)

每个终端标签页都在 Rust 后端通过 `portable-pty` 创建并拥有独立的 PTY。前端向后端发送输入字节流，并通过与会话 ID 绑定的 Tauri Channel 实时接收终端输出。

### 项目标签页组 (Project Tab Groups)

标签页按项目进行分组隔离。切换项目时会改变前端可见的标签页组，但终端组件依然保持挂载状态，后台进程和远程会话不会中断。

### 终端配置 (Profiles)

Profile 作为项目的一等资源进行存储。Rust 后端会根据已保存的配置自动解析可执行文件、命令行参数、工作目录、开发环境激活脚本、启动命令以及环境变量。

### 远程初始化 (Remote Initialization)

对于 SSH 项目，Project Terminal 会先建立交互式 SSH 会话，自动进入指定的远程工作目录，随后执行选定的远程初始化命令。若初始化过程失败，终端会显示错误提示，同时保留可用的远程 Shell。

## 安全特性

- SSH 连接调用系统内置的 `ssh` 可执行文件。
- 默认启用主机密钥校验 (Host-key verification)。
- 未知主机密钥需要用户明确确认。
- 主机密钥变更时将自动阻断连接，拒绝隐式接受。
- 密码与私钥口令直接在 PTY 终端内输入，应用绝不持久化或记录日志。
- 绝不存储任何私钥文件内容。
- Shell 及 SSH 参数以参数数组形式传递，严禁使用拼接字符串。
- 终端输入进行逐字节转发，不对内容进行解析或记录。
- Tauri 权限 (Capabilities) 严格限制为应用所需的最少权限。
- 配置文件写入具备原子性保护，损坏文件自动保留以供恢复。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 桌面框架 | Tauri 2 |
| 后端 | Rust |
| 前端 | React 18, TypeScript, Vite |
| UI | Tailwind CSS, Radix UI, shadcn/ui, Lucide |
| 状态管理 | Zustand |
| 终端渲染 | xterm.js |
| PTY 后端 | portable-pty |
| 持久化 | JSON 文件 |
| SSH | 系统内置 OpenSSH 客户端 |
| 测试 | Vitest 与 Rust 原生测试 |

## 开发指南

### 前置要求

- Node.js 20 或更高版本
- pnpm 9 或更高版本
- Rust stable 工具链
- Windows 平台需要安装包含 **使用 C++ 的桌面开发** 工作负载的 Microsoft C++ Build Tools
- Windows WebView2 Runtime
- 用于测试 SSH 项目的 Windows OpenSSH Client
- 用于测试 WSL 项目的 WSL 环境

### 安装依赖

```powershell
git clone https://github.com/Jackiechen259/project-terminal.git
cd project-terminal
pnpm install
```

### 运行桌面应用

```powershell
pnpm tauri:dev
```

### 仅运行前端界面

```powershell
pnpm dev
```

纯前端模式适用于 UI 开发，但 PTY、本地文件持久化、SSH 等 Tauri 原生能力需要运行完整的桌面应用。

### 构建安装包

```powershell
pnpm tauri:build
```

Windows 安装包将生成在：

```text
src-tauri/target/release/bundle/
```

## 可用脚本

| 命令 | 描述 |
| --- | --- |
| `pnpm dev` | 启动 Vite 开发服务器 |
| `pnpm build` | 执行 TypeScript 类型检查并构建前端 |
| `pnpm tauri:dev` | 以开发模式启动 Tauri 桌面应用 |
| `pnpm tauri:build` | 构建桌面应用及安装包 |
| `pnpm test` | 运行前端单元测试 |
| `pnpm test:watch` | 以监听模式运行 Vitest |
| `pnpm lint` | 运行 ESLint 检查 |
| `pnpm format` | 使用 Prettier 格式化前端代码 |
| `pnpm format:check` | 检查前端代码格式 |
| `pnpm bump` | 自动升级并同步项目版本号 (package.json / Tauri 配置) |

Rust 代码检查与测试：

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

## 项目目录结构

```text
project-terminal/
├── src/                         React & TypeScript 前端代码
│   ├── components/
│   │   ├── common/              通用反馈与对话框组件
│   │   ├── layout/              主布局与自定义标题栏
│   │   ├── profiles/            终端 Profile 配置 UI
│   │   ├── projects/            项目侧边栏与项目对话框
│   │   ├── ssh/                 SSH 连接管理 UI
│   │   └── terminal/            终端标签页、视图与工作区
│   ├── services/                Tauri 命令绑定
│   ├── stores/                  Zustand 状态管理
│   ├── types/                   前端领域类型定义
│   └── lib/                     共享工具函数
├── src-tauri/
│   ├── src/
│   │   ├── commands/            Tauri 命令处理函数
│   │   ├── environment/         开发环境激活与解析
│   │   ├── profile/             终端 Profile 模型与持久化
│   │   ├── project/             项目模型与持久化
│   │   ├── ssh/                 SSH 配置与命令构建
│   │   └── terminal/            PTY 会话与终端管理
│   ├── capabilities/            Tauri 权限配置
│   ├── Cargo.toml
│   └── tauri.conf.json
├── scripts/                     发布与版本管理脚本
├── .github/workflows/release.yml
├── package.json
└── README.md
```

## 发布流程

当推送以 `v` 开头的 Tag 时，GitHub Actions 会自动触发发布工作流。

在发布新版本之前，可以使用 bump 脚本自动更新并同步 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 以及 `src-tauri/Cargo.lock` 中的版本号：

```powershell
# 自动升级语义化版本号 (patch, minor, major 或 prerelease)
pnpm bump patch
pnpm bump minor
pnpm bump prerelease beta

# 或指定具体版本号
pnpm bump 0.3.0

# 预览版本升级（不写入文件）
pnpm bump patch --dry-run
```

随后提交版本修改、打 Tag 并推送到 GitHub：

```powershell
git add -A
git commit -m "chore: release v0.3.0"
git tag v0.3.0
git push origin v0.3.0
```

发布工作流将自动构建 Windows 与 Linux 安装包、为更新包签名、创建 GitHub Release 并发布更新元数据。

仓库中必须设置 GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`。私钥绝不可提交至代码库。请妥善保管备份，因为已安装的客户端信任与该私钥匹配并嵌入在 Tauri 配置中的公钥。

## 已知局限性

- 重启应用后不会自动恢复之前打开的终端会话。
- 终端输出历史不会持久化存储到磁盘。
- 绝不会自动接受未知的 SSH 主机密钥。
- 暂不支持终端分屏 (Split Panes)。
- 暂未内置文件管理器、代码编辑器、SFTP 浏览器、Git GUI 或端口转发图形界面。
- 暂不支持云端同步或跨设备 Profile 同步。
- 应用目前采用单主窗口设计。

## 开源协议

基于 [Apache License 2.0](./LICENSE) 协议开源。

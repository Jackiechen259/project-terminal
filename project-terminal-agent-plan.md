# Project Terminal — Agent Implementation Plan

> 目标：开发一个 Windows 桌面终端应用。左侧以 Project 为核心组织本地与 SSH 远程项目；每个 Project 拥有独立的终端标签页组；每个标签页对应独立的 PTY、Shell、运行环境与会话。应用支持 PowerShell、CMD、Git Bash、WSL、Conda、Python venv、Poetry、uv、自定义初始化流程，以及可保存的 SSH 远程项目。

---

# 1. 项目目标

开发一个暂名为 **Project Terminal** 的 Windows 桌面终端软件。

核心交互：

- 左侧侧边栏显示用户保存的 Project。
- Project 可以是：
  - 本地文件夹项目。
  - SSH 远程项目。
- 点击 Project 时：
  - 切换到该 Project 自己的终端标签页组。
  - 恢复该 Project 上次激活的标签页。
  - 如果该 Project 尚无标签页，则创建默认终端，或显示空状态。
- 每个 Project 拥有独立的 Terminal Tab Group。
- 每个标签页拥有独立的：
  - PTY。
  - Shell 进程。
  - 工作目录。
  - 环境变量。
  - Conda、venv 或其他开发环境。
  - SSH 会话。
- 切换 Project 或标签页时，不关闭会话、不销毁终端、不停止后台命令。
- 支持保存 Project、Terminal Profile、SSH 连接配置和 UI 偏好。
- 应用重启后恢复项目配置，但 MVP 不恢复正在运行的进程。

目标界面：

```text
┌────────────────────┬──────────────────────────────────────────────────────┐
│ Projects           │ 当前 Project 的标签页组                              │
│                    │ Terminal 1 │ Conda │ SSH │ + ▼                       │
│ ● Local Project A  ├──────────────────────────────────────────────────────┤
│   Local Project B  │                                                      │
│   SSH: Server A    │                 Terminal View                        │
│   SSH: GPU Server  │                                                      │
│                    │                                                      │
│ + Add Project      │                                                      │
│ Settings           │                                                      │
└────────────────────┴──────────────────────────────────────────────────────┘
```

---

# 2. 技术栈

## 2.1 桌面端

- Tauri 2
- Rust
- Windows 作为第一目标平台
- 后续保持可扩展到 Linux 和 macOS，但不得为了跨平台牺牲 Windows MVP

## 2.2 前端

- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- Zustand
- Lucide Icons

## 2.3 终端

- `@xterm/xterm`
- `@xterm/addon-fit`
- 可选：
  - `@xterm/addon-web-links`
  - `@xterm/addon-search`
  - `@xterm/addon-unicode11`
- Rust `portable-pty`
- Tauri Channel 用于持续 PTY 输出
- Tauri Commands 用于：
  - 创建终端。
  - 写入终端。
  - 调整大小。
  - 关闭终端。
  - 重启终端。
  - 测试 Profile。
  - 管理项目和配置。

## 2.4 数据存储

MVP 使用 JSON，不引入数据库。

建议文件：

```text
%APPDATA%\ProjectTerminal\projects.json
%APPDATA%\ProjectTerminal\profiles.json
%APPDATA%\ProjectTerminal\ssh-connections.json
%APPDATA%\ProjectTerminal\settings.json
```

要求：

- 通过 Tauri 或 Rust 获取应用配置目录。
- 不硬编码用户名。
- 不将配置写入应用安装目录。
- 未来可迁移到 SQLite，但不属于 MVP。

## 2.5 密钥与密码存储

- SSH 私钥文件只保存路径，不复制密钥内容。
- SSH 密码、私钥 passphrase、Token 不允许明文保存在 JSON。
- MVP 推荐：
  - 优先使用系统 `ssh-agent`。
  - 或每次连接时提示输入密码或 passphrase。
- 后续可接入 Windows Credential Manager。
- 即使使用系统凭据存储，也不得将秘密写入日志或前端持久状态。

---

# 3. 核心领域模型

应用必须分离以下概念：

```text
Project
  ├─ Execution Target
  │    ├─ Local
  │    └─ SSH Remote
  ├─ Terminal Profiles
  │    ├─ Shell
  │    ├─ Working Directory
  │    ├─ Environment
  │    ├─ Environment Variables
  │    └─ Startup Commands
  └─ Project Tab Group
       ├─ Terminal Tab 1
       ├─ Terminal Tab 2
       └─ Terminal Tab 3
```

禁止将 Project、Shell、Conda Environment 和 SSH Connection 混合为一个不可扩展的数据结构。

---

# 4. MVP 范围

必须完成：

1. 添加、编辑、删除本地项目。
2. 添加、编辑、删除 SSH 远程项目。
3. 左侧侧边栏显示所有项目。
4. 每个 Project 拥有独立标签页组。
5. 切换 Project 时切换对应标签页组。
6. 切换回来时恢复该 Project 上次激活标签页。
7. 每个标签页对应独立 PTY 和 Shell。
8. 支持 PowerShell、CMD 和自定义 Shell。
9. 支持 Git Bash 和 WSL 的基础检测与 Profile。
10. 支持普通终端、Conda、Python venv 和自定义环境初始化。
11. 支持 Poetry 和 uv 的基础 Profile。
12. 支持保存多个 Terminal Profile。
13. 支持 SSH 远程终端。
14. SSH 项目可以保存：
    - Host。
    - Port。
    - Username。
    - Remote Path。
    - Authentication Method。
    - Key Path。
    - Jump Host。
    - Default Terminal Profile。
15. SSH 远程项目支持远端工作目录。
16. SSH 远程项目支持远端 Conda、venv 或自定义初始化。
17. 标签页切换、关闭和重启。
18. 支持项目内新建第二个、第三个终端。
19. 支持终端输入、输出和 resize。
20. 配置持久化。
21. 应用退出时清理所有本地和 SSH 子进程。
22. 支持中文和空格路径。
23. 提供结构化错误提示。
24. 提供基本 Rust 与前端测试。
25. 能生成 Windows 安装包。

MVP 暂不实现：

- AI 命令建议。
- 终端分屏。
- 云同步。
- 完整文件管理器。
- 内置编辑器。
- SSH 文件传输界面。
- SFTP 浏览器。
- SSH 端口转发管理 UI。
- 完整 Git GUI。
- 多窗口。
- 插件系统。
- 运行中会话跨应用重启恢复。
- 终端输出持久化。
- 自动创建或修改 Conda 环境。
- 自动执行 `pip install`、`uv sync`、`poetry install`。
- 自动更新远程服务器配置。
- 自动接受未知 SSH Host Key。

---

# 5. 推荐项目结构

```text
project-terminal/
├─ src/
│  ├─ components/
│  │  ├─ layout/
│  │  │  ├─ AppLayout.tsx
│  │  │  └─ TitleBar.tsx
│  │  ├─ projects/
│  │  │  ├─ ProjectSidebar.tsx
│  │  │  ├─ ProjectItem.tsx
│  │  │  ├─ ProjectDialog.tsx
│  │  │  ├─ ProjectContextMenu.tsx
│  │  │  └─ ProjectEmptyState.tsx
│  │  ├─ profiles/
│  │  │  ├─ TerminalProfileDialog.tsx
│  │  │  ├─ TerminalProfileList.tsx
│  │  │  ├─ EnvironmentFields.tsx
│  │  │  └─ ProfileTestResult.tsx
│  │  ├─ ssh/
│  │  │  ├─ SshConnectionDialog.tsx
│  │  │  ├─ SshAuthenticationFields.tsx
│  │  │  ├─ HostKeyDialog.tsx
│  │  │  └─ SshConnectionTest.tsx
│  │  ├─ terminal/
│  │  │  ├─ ProjectTerminalGroup.tsx
│  │  │  ├─ TerminalTabs.tsx
│  │  │  ├─ TerminalTabItem.tsx
│  │  │  ├─ TerminalWorkspace.tsx
│  │  │  ├─ TerminalView.tsx
│  │  │  └─ TerminalEmptyState.tsx
│  │  └─ common/
│  │     ├─ ErrorBanner.tsx
│  │     ├─ ConfirmDialog.tsx
│  │     └─ LoadingState.tsx
│  ├─ stores/
│  │  ├─ projectStore.ts
│  │  ├─ profileStore.ts
│  │  ├─ terminalStore.ts
│  │  ├─ sshStore.ts
│  │  └─ settingsStore.ts
│  ├─ services/
│  │  ├─ projectService.ts
│  │  ├─ profileService.ts
│  │  ├─ terminalService.ts
│  │  └─ sshService.ts
│  ├─ types/
│  │  ├─ project.ts
│  │  ├─ profile.ts
│  │  ├─ terminal.ts
│  │  ├─ ssh.ts
│  │  └─ settings.ts
│  ├─ lib/
│  │  └─ utils.ts
│  ├─ App.tsx
│  └─ main.tsx
│
├─ src-tauri/
│  ├─ src/
│  │  ├─ commands/
│  │  │  ├─ mod.rs
│  │  │  ├─ project.rs
│  │  │  ├─ profile.rs
│  │  │  ├─ terminal.rs
│  │  │  └─ ssh.rs
│  │  ├─ project/
│  │  │  ├─ mod.rs
│  │  │  ├─ model.rs
│  │  │  └─ repository.rs
│  │  ├─ profile/
│  │  │  ├─ mod.rs
│  │  │  ├─ model.rs
│  │  │  ├─ repository.rs
│  │  │  └─ resolver.rs
│  │  ├─ ssh/
│  │  │  ├─ mod.rs
│  │  │  ├─ model.rs
│  │  │  ├─ command_builder.rs
│  │  │  ├─ host_key.rs
│  │  │  └─ detector.rs
│  │  ├─ terminal/
│  │  │  ├─ mod.rs
│  │  │  ├─ manager.rs
│  │  │  ├─ session.rs
│  │  │  ├─ initializer.rs
│  │  │  └─ escaping.rs
│  │  ├─ environment/
│  │  │  ├─ mod.rs
│  │  │  ├─ conda.rs
│  │  │  ├─ venv.rs
│  │  │  ├─ poetry.rs
│  │  │  └─ uv.rs
│  │  ├─ error.rs
│  │  ├─ state.rs
│  │  ├─ lib.rs
│  │  └─ main.rs
│  ├─ capabilities/
│  │  └─ default.json
│  ├─ Cargo.toml
│  └─ tauri.conf.json
│
├─ package.json
└─ README.md
```

避免：

- 把所有 Rust 代码放进 `lib.rs`。
- 把所有 React 状态放进 `App.tsx`。
- 在 React 组件中拼接 Shell 命令。
- 在前端直接执行系统命令。

---

# 6. Project 数据模型

## 6.1 Project 类型

```ts
export type ProjectType = "local" | "ssh";

export interface Project {
  id: string;
  name: string;
  type: ProjectType;

  local?: LocalProjectConfig;
  sshConnectionId?: string;

  defaultProfileId?: string;

  createdAt: string;
  updatedAt: string;
}
```

## 6.2 本地项目

```ts
export interface LocalProjectConfig {
  path: string;
}
```

示例：

```json
{
  "id": "project-local-smolvla",
  "name": "SmolVLA",
  "type": "local",
  "local": {
    "path": "D:\\Projects\\SmolVLA"
  },
  "defaultProfileId": "profile-conda-smolvla"
}
```

## 6.3 SSH 远程项目

SSH Project 通过 `sshConnectionId` 引用独立连接配置。

示例：

```json
{
  "id": "project-ssh-katana",
  "name": "Katana SmolVLA",
  "type": "ssh",
  "sshConnectionId": "ssh-katana",
  "defaultProfileId": "profile-remote-conda"
}
```

将 SSH Connection 独立建模，以便多个 Project 复用同一台服务器，但使用不同 Remote Path。

如果需要多个项目共享同一 SSH Connection，Project 还应保存自己的远端路径：

```ts
export interface SshProjectConfig {
  connectionId: string;
  remotePath: string;
}
```

推荐最终模型：

```ts
export interface Project {
  id: string;
  name: string;
  type: "local" | "ssh";

  local?: {
    path: string;
  };

  ssh?: {
    connectionId: string;
    remotePath: string;
  };

  defaultProfileId?: string;

  createdAt: string;
  updatedAt: string;
}
```

---

# 7. SSH Connection 数据模型

```ts
export type SshAuthenticationType =
  | "agent"
  | "key"
  | "password"
  | "keyboard-interactive"
  | "system-config";

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
```

要求：

- 默认端口为 22。
- Host、Username 不能为空。
- Port 范围为 1–65535。
- Key Authentication 时，`identityFile` 必须存在。
- Password 不保存到 JSON。
- `extraArgs` 只能作为高级配置，且必须逐项验证。
- 不允许用户通过 `extraArgs` 覆盖应用的安全策略，例如自动接受未知 Host Key，除非 UI 明确提示风险。

---

# 8. Terminal Profile 数据模型

## 8.1 Shell 类型

```ts
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
```

## 8.2 Environment 类型

```ts
export type EnvironmentType =
  | "none"
  | "conda"
  | "venv"
  | "poetry"
  | "uv"
  | "custom";
```

## 8.3 Terminal Profile

```ts
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
```

Profile 必须属于某个 Project。

同一个 Project 可以拥有多个 Profile：

```text
Local SmolVLA
├─ PowerShell
├─ Conda: smolvla
├─ Conda: lerobot
└─ WSL: Ubuntu

SSH Katana
├─ Remote Default Shell
├─ Remote Conda: smolvla
├─ Remote Python venv
└─ Remote Zsh
```

---

# 9. Terminal Tab 与 Project Tab Group

## 9.1 TerminalTab

```ts
export type TerminalStatus =
  | "starting"
  | "connecting"
  | "initializing"
  | "running"
  | "exited"
  | "error";

export interface TerminalTab {
  id: string;
  sessionId: string;

  projectId: string;
  profileId: string;

  title: string;
  cwd: string;

  status: TerminalStatus;
  exitCode?: number;

  createdAt: number;
  lastActivatedAt: number;
}
```

每个标签页必须包含：

- `projectId`
- `profileId`
- `sessionId`

禁止无 Project 归属或无 Profile 归属的标签页。

## 9.2 ProjectTabGroup

```ts
export interface ProjectTabGroup {
  projectId: string;
  tabIds: string[];
  activeTabId: string | null;
}
```

## 9.3 Zustand 状态

```ts
interface TerminalState {
  activeProjectId: string | null;

  tabsById: Record<string, TerminalTab>;

  tabGroupsByProjectId: Record<string, ProjectTabGroup>;
}
```

不要使用单一全局：

```ts
tabs: TerminalTab[];
activeTabId: string | null;
```

因为这会导致不同 Project 的标签页混在一起。

---

# 10. Project 切换规则

选择 Project 时：

1. 设置 `activeProjectId`。
2. 查找该 Project 的 `ProjectTabGroup`。
3. 如果已有标签页：
   - 恢复该组的 `activeTabId`。
   - 只显示该 Project 的标签栏。
4. 如果没有标签页：
   - MVP 可自动创建默认 Profile 终端。
   - 或显示 “No terminals open” 空状态。
5. 不关闭其他 Project 的终端。
6. 不 dispose 其他 Project 的 xterm 实例。
7. 不停止后台命令。
8. 不重新执行 Conda 或 SSH 初始化。
9. 不重新建立 SSH 连接。
10. 只改变可见性。

示例：

```text
Project A
├─ Terminal 1
└─ Conda

Project B
├─ SSH 1
├─ SSH 2
└─ Remote Conda
```

选择 Project A 时只显示 A 的标签。

选择 Project B 时只显示 B 的标签。

再次选择 A 时恢复 A 上次激活的标签。

---

# 11. PTY 与 TerminalManager

每个标签页对应独立 PTY。

Rust：

```rust
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}
```

每个 `TerminalSession` 至少包含：

- Session ID。
- Project ID。
- Profile ID。
- Session kind：
  - Local。
  - SSH。
- PTY master。
- PTY writer。
- Child process。
- rows。
- cols。
- closing 状态。
- 初始化状态。
- 输出 Channel。

禁止：

- 多个标签页共享一个 PowerShell。
- 多个 SSH 标签页共享同一个交互 Shell。
- 通过重复 `cd` 模拟多标签页。
- 使用普通 stdout pipe 替代 PTY。
- 将一个终端输出广播给所有标签页。

---

# 12. Tauri Commands

## 12.1 Project

```text
list_projects
create_project
update_project
delete_project
validate_project
```

## 12.2 Terminal Profile

```text
list_terminal_profiles
create_terminal_profile
update_terminal_profile
delete_terminal_profile
validate_terminal_profile
test_terminal_profile
```

## 12.3 Terminal

```text
create_terminal
write_terminal
resize_terminal
close_terminal
restart_terminal
```

推荐创建接口：

```ts
interface CreateTerminalRequest {
  projectId: string;
  profileId: string;
  rows: number;
  cols: number;
}
```

前端不得提交任意 executable 或 command。

后端根据 `projectId` 和 `profileId` 从已保存配置解析：

- Project 类型。
- Local Path 或 Remote Path。
- Shell。
- Environment。
- SSH Connection。
- Activation Command。
- Startup Commands。
- Environment Variables。

## 12.4 Conda 与环境检测

```text
detect_conda_installations
list_conda_environments
validate_conda_environment
detect_project_environments
```

## 12.5 SSH

```text
list_ssh_connections
create_ssh_connection
update_ssh_connection
delete_ssh_connection
validate_ssh_connection
test_ssh_connection
detect_ssh_client
read_ssh_host_fingerprint
```

---

# 13. 本地终端创建流程

创建本地终端：

1. 根据 `projectId` 获取 Project。
2. 验证 Project 类型为 `local`。
3. 验证本地路径存在且为目录。
4. 根据 `profileId` 获取 Profile。
5. 验证 Profile 属于该 Project。
6. 解析 Shell executable。
7. 构建单会话环境变量。
8. 创建 PTY。
9. 设置 rows 和 cols。
10. 启动 Shell。
11. 启动输出读取线程。
12. 发送初始化状态。
13. 初始化环境。
14. 执行 startup commands。
15. 标记 `running`。
16. 返回 `sessionId`。

---

# 14. SSH 远程终端架构

## 14.1 MVP 推荐方案

MVP 使用 Windows 系统 OpenSSH 客户端：

```text
ssh.exe
```

在本地 PTY 中启动 `ssh.exe`。

架构：

```text
xterm.js
  ↕ Tauri Channel / Commands
Rust portable-pty
  ↕
Windows ssh.exe
  ↕
Remote SSH Server
  ↕
Remote Shell
```

优点：

- 可获得完整交互式终端行为。
- 支持系统 `ssh-agent`。
- 支持 `~/.ssh/config`。
- 支持 ProxyJump。
- 支持 Host Key 检查。
- 支持密码、keyboard-interactive 和 key passphrase 交互。
- 不需要在 Rust 中自行实现完整 SSH 协议。

不要在 MVP 中自行实现 SSH 协议栈，除非系统 OpenSSH 无法满足需求。

## 14.2 SSH 客户端检测

优先级：

1. 用户指定的 `ssh.exe`。
2. PATH 中的 `ssh.exe`。
3. Windows 常见路径：
   - `%WINDIR%\System32\OpenSSH\ssh.exe`
4. Git 自带 OpenSSH 可作为候选，但不得默认优先于系统 OpenSSH。
5. 如果没有找到，显示明确错误和安装提示。

## 14.3 SSH 命令构建

使用参数数组，不使用字符串拼接。

逻辑参数示例：

```text
ssh.exe
-T 或 -t
-p 22
-l username
-i C:\Users\User\.ssh\id_ed25519
-o ServerAliveInterval=30
-o ServerAliveCountMax=3
-o StrictHostKeyChecking=yes
-J jumpuser@jumphost:22
host
```

对于交互式远程终端，需要分配 TTY。

根据 OpenSSH 行为选择合适的 `-t` 或 `-tt`，并通过真实测试确认。

必须避免：

```rust
format!("ssh {}@{}", username, host)
```

所有参数通过 `CommandBuilder` 的参数数组传递。

## 14.4 远端工作目录

连接成功后应进入 Project 的 `remotePath`。

不要假设 OpenSSH 客户端提供跨所有服务端 Shell 都统一可用的 cwd 参数。

推荐方式：

- 建立交互式远程 Shell。
- 在远端 Shell 就绪后发送安全转义后的 `cd` 命令。
- 再执行环境初始化。

例如 Bash/Zsh：

```bash
cd -- '/home/user/projects/smolvla'
```

PowerShell Remoting Shell 或远端 Windows OpenSSH：

```powershell
Set-Location -LiteralPath 'D:\Projects\SmolVLA'
```

Profile 必须知道远端 Shell 类型，才能正确生成命令。

## 14.5 远端初始化顺序

```text
1. Start local PTY
2. Start ssh.exe
3. Complete host-key/authentication interaction
4. Enter remote shell
5. Change to remote project path
6. Initialize remote environment
7. Run remote startup commands
8. Mark session as running
```

切换标签页或 Project 时不得重复以上初始化。

## 14.6 SSH 状态

标签页状态：

```text
starting
→ connecting
→ initializing
→ running
```

失败时：

```text
error
```

但如果远程 Shell 已经可用，只是环境初始化失败，应保留 Shell，允许用户手动修复。

---

# 15. SSH Host Key 安全

必须遵守：

1. 默认开启 Host Key 验证。
2. 不得默认使用：

```text
StrictHostKeyChecking=no
UserKnownHostsFile=/dev/null
```

3. 首次连接未知主机时：
   - 显示 Host。
   - 显示端口。
   - 显示 Key Type。
   - 显示 Fingerprint。
   - 要求用户确认。
4. Host Key 变化时：
   - 阻止连接。
   - 显示风险警告。
   - 不允许静默覆盖。
5. `known_hosts` 默认使用系统 OpenSSH 配置。
6. 允许高级用户指定独立 `knownHostsFile`。
7. 不解析或修改用户 `known_hosts`，除非用户明确执行该操作。
8. Host Key 错误不得被当作普通网络重试。

---

# 16. SSH Authentication

支持：

## 16.1 SSH Agent

```ts
authenticationType: "agent"
useSshAgent: true
```

优先推荐。

应用不读取私钥内容。

## 16.2 Key File

```ts
authenticationType: "key"
identityFile: "C:\\Users\\User\\.ssh\\id_ed25519"
```

要求：

- 路径存在。
- 只保存路径。
- Passphrase 由 OpenSSH 在终端内交互输入。
- 不记录输入。

## 16.3 Password

```ts
authenticationType: "password"
```

MVP 行为：

- 不保存密码。
- 由 `ssh.exe` 在 PTY 中提示用户输入。
- xterm.js 正常传递输入。
- 不截获、记录或回显密码内容。

## 16.4 Keyboard Interactive

允许 SSH 服务端发起交互式验证。

不要假设所有提示都是 password。

## 16.5 System SSH Config

```ts
authenticationType: "system-config"
```

允许用户使用 `~/.ssh/config` 中的 Host Alias。

此时：

- `host` 可以是 SSH Config Alias。
- 不强制要求重复输入 username、key、jump host。
- 但 Project UI 应明确显示“使用系统 SSH 配置”。

---

# 17. Jump Host 与 ProxyJump

支持一个 Jump Host：

```ts
jumpHost: {
  host: "gateway.example.com",
  port: 22,
  username: "user"
}
```

对应 OpenSSH `-J`。

MVP 不需要提供多级 Jump Host 图形编辑器。

如果用户使用多级 ProxyJump，可通过系统 `~/.ssh/config` 实现。

不得在字符串中手动拼接未经转义的 ProxyCommand。

---

# 18. SSH Keepalive 与超时

默认配置建议：

```text
ConnectTimeout = 15 seconds
ServerAliveInterval = 30 seconds
ServerAliveCountMax = 3
```

要求：

- 配置可在 Connection Profile 中修改。
- 连接中断后终端显示退出状态。
- MVP 不自动无限重连。
- 可提供 “Reconnect” 按钮。
- 重连创建新 Session，不复用已退出的 ssh 进程。
- 不自动重放用户之前输入的命令。

---

# 19. 本地与远端环境兼容

Terminal Profile 的 Environment 逻辑必须同时支持 Local 和 SSH。

## 19.1 Local Conda

在本地 Shell 中加载本地 Conda Hook。

## 19.2 Remote Conda

在远端 Shell 中加载远端 Conda 初始化脚本。

示例 Bash：

```bash
source ~/miniconda3/etc/profile.d/conda.sh
conda activate smolvla
```

示例远端 PowerShell：

```powershell
& "D:\program\anaconda\shell\condabin\conda-hook.ps1"
conda activate "smolvla"
```

本地 Conda Root 和远端 Conda Root 必须分开配置。

禁止将：

```text
D:\program\anaconda
```

当作 Linux 远端路径使用。

---

# 20. Conda 支持

## 20.1 Conda Config

```ts
export interface CondaEnvironmentConfig {
  condaExecutable?: string;
  condaRoot?: string;

  environmentName?: string;
  environmentPath?: string;

  activationMode:
    | "shell-hook"
    | "conda-bat"
    | "manual-command";

  autoActivate: boolean;
}
```

名称和路径至少一个存在。

## 20.2 本地 Conda 检测

检测优先级：

1. Profile 指定路径。
2. `CONDA_EXE`。
3. PATH 中 `conda.exe`。
4. PATH 中 `conda.bat`。
5. 常见目录。
6. 用户手动选择。

常见候选：

```text
%USERPROFILE%\anaconda3
%USERPROFILE%\miniconda3
%USERPROFILE%\miniforge3
%LOCALAPPDATA%\anaconda3
%LOCALAPPDATA%\miniconda3
C:\ProgramData\anaconda3
C:\ProgramData\miniconda3
```

必须支持其他盘符，例如：

```text
D:\program\anaconda
```

可能使用：

```text
<conda-root>\Scripts\conda.exe
<conda-root>\condabin\conda.bat
<conda-root>\shell\condabin\conda-hook.ps1
```

## 20.3 Conda 环境列表

使用结构化输出：

```powershell
conda env list --json
```

后端解析 JSON，不解析表格文本。

```ts
export interface DetectedCondaEnvironment {
  name?: string;
  path: string;
  isActive: boolean;
  isBase: boolean;
}
```

## 20.4 PowerShell 激活

```powershell
& "D:\program\anaconda\shell\condabin\conda-hook.ps1"
conda activate "smolvla"
```

或完整路径：

```powershell
conda activate "D:\program\anaconda\envs\smolvla"
```

不要使用：

```powershell
conda.exe activate smolvla
```

来替代当前交互 Shell 的环境激活。

## 20.5 CMD 激活

```cmd
call "D:\program\anaconda\condabin\conda.bat" activate smolvla
```

必须使用 `call`。

## 20.6 Git Bash 激活

```bash
source /d/program/anaconda/etc/profile.d/conda.sh
conda activate smolvla
```

路径转换必须可验证。

无法可靠转换时，要求用户确认初始化命令。

## 20.7 WSL Conda

WSL 使用 WSL 内部 Conda：

```bash
source ~/miniconda3/etc/profile.d/conda.sh
conda activate smolvla
```

Windows Conda 与 WSL Conda 是两个独立配置。

## 20.8 Remote Conda

远端 Profile 保存远端初始化命令或远端 Conda Root。

不得在本机调用 `conda env list` 来推断远端环境。

MVP 可让用户：

- 手动填写远端环境名。
- 手动填写 activation command。
- 使用 “Test Remote Profile” 验证。

后续可通过 SSH 执行结构化命令获取远端环境列表，但不得阻塞 MVP。

---

# 21. Python venv、Poetry 和 uv

## 21.1 venv

PowerShell：

```powershell
& ".\.venv\Scripts\Activate.ps1"
```

CMD：

```cmd
.\.venv\Scripts\activate.bat
```

Git Bash：

```bash
source .venv/Scripts/activate
```

远端 Linux：

```bash
source .venv/bin/activate
```

激活命令必须根据执行目标和 Shell 类型生成。

## 21.2 Poetry

优先解析环境路径：

```powershell
poetry env info --path
```

然后激活对应 venv。

不要依赖 `poetry shell` 作为唯一实现。

## 21.3 uv

支持项目 `.venv`。

如果 `.venv` 不存在，不自动运行：

```text
uv sync
```

除非用户明确触发。

## 21.4 Custom

允许用户配置：

- activation command。
- startup commands。
- 环境变量。

自定义命令属于用户主动保存的 Profile。

---

# 22. 初始化命令顺序

每个 Session 使用明确顺序：

```text
1. Resolve Project
2. Resolve Terminal Profile
3. Resolve Execution Target
4. Validate Local or Remote Working Directory
5. Resolve Shell or SSH Client
6. Build per-session Environment Variables
7. Create PTY
8. Start local Shell or ssh.exe
9. Wait until interactive shell is available
10. Change to Project Working Directory
11. Initialize Environment
12. Run Startup Commands
13. Mark Session as Running
```

环境初始化只在：

- 创建 Session。
- 重启 Session。
- SSH 重连创建新 Session。

时执行。

切换 Tab 或 Project 时不得重新执行。

---

# 23. Environment Variables

Profile 可以配置：

```json
{
  "PYTHONUTF8": "1",
  "HF_HOME": "D:\\Models\\huggingface",
  "PROJECT_MODE": "development"
}
```

本地 Session：

1. 继承应用环境。
2. 在 `CommandBuilder` 上覆盖 Profile 变量。
3. 添加内部标记：

```text
TERM=xterm-256color
COLORTERM=truecolor
PROJECT_TERMINAL=1
PROJECT_TERMINAL_PROJECT_ID=<project-id>
PROJECT_TERMINAL_PROFILE_ID=<profile-id>
```

禁止调用全局：

```rust
std::env::set_var(...)
```

来配置单个会话。

远程 Session 的环境变量：

- 不能假设本地环境变量会被 SSH 自动传递。
- 需要在远端初始化命令中按远端 Shell 语法设置。
- 默认只允许用户显式配置的变量。
- 不自动转发本地所有环境变量。
- 不自动转发 Token、代理密码或 SSH Agent 之外的秘密。

---

# 24. Shell 与命令转义

必须实现：

```rust
escape_powershell_argument
escape_cmd_argument
escape_bash_argument
escape_remote_posix_argument
```

要求：

- 处理空格。
- 处理 Unicode。
- 处理引号。
- 处理 `&`、`|`、`;`、括号等特殊字符。
- 不使用同一个通用函数处理所有 Shell。
- 能使用参数数组时，优先使用参数数组。
- 只有必须写入交互 Shell 的命令才生成 Shell 文本。

---

# 25. xterm.js 前端

## 25.1 基础配置

```ts
const terminal = new Terminal({
  cursorBlink: true,
  cursorStyle: "block",
  scrollback: 10_000,
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  fontSize: 14,
  lineHeight: 1.2,
  allowTransparency: false,
  convertEol: false
});
```

## 25.2 输入

```ts
terminal.onData((data) => {
  terminalService.write(sessionId, data);
});
```

不要解析用户输入。

必须支持：

- Ctrl+C。
- Ctrl+D。
- Ctrl+L。
- Tab。
- Backspace。
- 方向键。
- SSH 密码输入。
- Python REPL。
- Vim、Nano、htop 等交互程序。

## 25.3 输出

使用 Tauri Channel 接收字节块。

```ts
terminal.write(new Uint8Array(message.data));
```

输出必须按 `sessionId` 路由。

## 25.4 Resize

- 使用 `ResizeObserver`。
- 调用 `fitAddon.fit()`。
- 将 rows 和 cols 发送后端。
- 使用 50–100 ms 防抖。
- 激活隐藏终端后再次 fit。

## 25.5 生命周期

切换标签页或 Project 时保持 TerminalView 挂载，只隐藏：

```tsx
{Object.values(tabsById).map((tab) => {
  const group = tabGroupsByProjectId[tab.projectId];

  const visible =
    tab.projectId === activeProjectId &&
    group?.activeTabId === tab.id;

  return (
    <div
      key={tab.id}
      className={visible ? "h-full w-full" : "hidden"}
    >
      <TerminalView
        sessionId={tab.sessionId}
        active={visible}
      />
    </div>
  );
})}
```

关闭标签页时才 dispose。

---

# 26. 标签页行为

## 26.1 新建终端

普通 `+`：

- 使用当前 Project 默认 Profile。

下拉菜单：

```text
PowerShell
Conda: smolvla
Python venv
WSL: Ubuntu
SSH Remote Default
Remote Conda
Manage Profiles...
```

## 26.2 标题

项目内独立编号：

```text
Project A
├─ Terminal 1
├─ Terminal 2
└─ Conda

Project B
├─ Terminal 1
└─ SSH 1
```

不要全局编号。

## 26.3 关闭

1. 调用 `close_terminal`。
2. 删除 `tabsById`。
3. 从所属 ProjectTabGroup 删除。
4. 激活右侧标签，若无则左侧。
5. 不影响其他 Project。
6. 如果无剩余标签，显示 Empty State。

## 26.4 退出

Shell 或 SSH 自己退出后：

- 标签页保留。
- 状态显示 `Exited`。
- 显示退出码。
- 提供：
  - Restart。
  - Reconnect。
  - Close。
- 不立即删除历史输出。

---

# 27. Project Sidebar

每个项目显示：

- Local 或 SSH 图标。
- 项目名称。
- 活动标签数量。
- 当前是否选中。
- 是否有 Running、Error 或 Exited Session。
- 新建终端按钮。
- 更多菜单。

本地项目菜单：

```text
Open Default Terminal
New Terminal With Profile >
Open in File Explorer
Manage Terminal Profiles
Edit Project
Remove Project
```

SSH 项目菜单：

```text
Connect With Default Profile
New Remote Terminal With Profile >
Test SSH Connection
Manage Terminal Profiles
Edit SSH Project
Edit SSH Connection
Remove Project
```

点击项目右侧 `+` 时必须 `stopPropagation()`，避免重复创建。

---

# 28. 添加与编辑 Project UI

## 28.1 Project 类型

```text
Local Folder
SSH Remote
```

## 28.2 Local Project 字段

```text
Project Name
Local Path
Default Terminal Profile
```

提供 Windows 文件夹选择器。

## 28.3 SSH Project 字段

```text
Project Name
SSH Connection
Remote Path
Default Terminal Profile
```

可以：

- 选择已有 SSH Connection。
- 创建新 SSH Connection。

## 28.4 SSH Connection 字段

```text
Connection Name
Host
Port
Username
Authentication Type
Identity File
Use SSH Agent
Jump Host
Connect Timeout
Keepalive
Host Key Checking
Known Hosts File
```

提供 “Test Connection”。

测试连接不得修改远端文件。

---

# 29. Profile UI

字段：

```text
Profile Name
Shell
Environment Type
Environment Name
Environment Path
Environment Manager Path
Activation Command
Startup Commands
Environment Variables
Set as Default
```

Local Conda：

```text
Detect Conda
Refresh Environments
Test Profile
```

SSH Remote：

```text
Remote Shell Type
Remote Activation Command
Remote Startup Commands
Test Remote Profile
```

自动检测项目文件：

```text
environment.yml
conda.yml
.venv
venv
pyproject.toml
poetry.lock
uv.lock
requirements.txt
package.json
```

检测结果只能建议，不自动安装或修改环境。

---

# 30. 配置持久化

## 30.1 安全写入

1. 序列化完整 JSON。
2. 写入临时文件。
3. flush。
4. 替换正式文件。
5. 失败时保留原文件。

## 30.2 配置损坏

- 不覆盖损坏文件。
- 备份为带时间戳文件。
- 返回可读错误。
- UI 显示恢复建议。
- 如果文件不存在，返回空数组。

## 30.3 不持久化内容

MVP 不保存：

- 终端输入。
- 终端输出。
- SSH 密码。
- Key passphrase。
- 当前子进程句柄。
- 运行中 Session。
- Conda Token。
- 环境中的秘密变量。

---

# 31. 删除规则

## 31.1 删除 Project

如果 Project 有打开标签页：

```text
This project has active terminal sessions.

Close terminals and remove project
Cancel
```

MVP 不支持保留无 Project 归属的 Detached Sessions。

确认后：

1. 关闭该 Project 的所有 Session。
2. 删除其全部 Tabs。
3. 删除 ProjectTabGroup。
4. 删除 Profiles。
5. 删除 Project 配置。
6. 不自动删除 SSH Connection，除非没有其他项目引用且用户明确确认。
7. 如果删除当前 Project，选择下一个项目。

## 31.2 删除 SSH Connection

如果仍被 Project 使用：

- 阻止删除。
- 显示引用它的 Project。
- 或要求用户先修改/删除这些项目。

---

# 32. 错误类型

Rust 统一错误：

```rust
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Project was not found: {0}")]
    ProjectNotFound(String),

    #[error("Project path does not exist: {0}")]
    ProjectPathNotFound(String),

    #[error("Remote project path is invalid: {0}")]
    RemotePathInvalid(String),

    #[error("Terminal profile was not found: {0}")]
    ProfileNotFound(String),

    #[error("Shell executable was not found: {0}")]
    ShellNotFound(String),

    #[error("SSH client was not found")]
    SshClientNotFound,

    #[error("SSH connection was not found: {0}")]
    SshConnectionNotFound(String),

    #[error("SSH host key verification failed: {0}")]
    SshHostKeyFailed(String),

    #[error("SSH authentication failed: {0}")]
    SshAuthenticationFailed(String),

    #[error("SSH connection failed: {0}")]
    SshConnectionFailed(String),

    #[error("Terminal session was not found: {0}")]
    SessionNotFound(String),

    #[error("Failed to create PTY: {0}")]
    PtyCreationFailed(String),

    #[error("Failed to start shell: {0}")]
    ShellStartFailed(String),

    #[error("Environment initialization failed: {0}")]
    EnvironmentInitializationFailed(String),

    #[error("Configuration error: {0}")]
    Configuration(String),

    #[error("I/O error: {0}")]
    Io(String),
}
```

所有错误返回前端前必须结构化和可序列化。

---

# 33. 安全要求

必须遵守：

1. 不暴露任意命令执行 API。
2. 不实现：

```text
execute_any_command(command: string)
```

3. 创建终端只接受 `projectId` 和 `profileId`。
4. executable、cwd、SSH 参数从已验证配置解析。
5. 自定义 Shell 只允许来自用户保存的 Profile。
6. Shell 参数使用数组，不拼接字符串。
7. SSH 参数使用数组。
8. 默认启用 SSH Host Key 验证。
9. 不自动接受未知或变化的 Host Key。
10. 不将 SSH 密码存入 JSON。
11. 不将私钥内容读入前端。
12. 不记录终端输入。
13. 不记录终端完整输出。
14. 不记录密码、Token、代理凭据、环境秘密。
15. Profile 环境变量只影响对应 Session。
16. 不修改应用全局环境模拟 Conda。
17. 不自动创建、更新、删除 Conda 环境。
18. 不自动执行依赖安装。
19. 不自动执行远端危险命令。
20. Tauri capabilities 只开放必要权限。
21. 文件选择器结果必须再次由 Rust 验证。
22. 路径必须支持 Unicode 和空格。
23. Remote Path 命令必须按远端 Shell 正确转义。
24. Host Key 变化属于安全错误，不自动重试。
25. SSH Password 输入必须透传 PTY，不得截获。

---

# 34. UI 设计要求

- 类似 VS Code、Warp、Windows Terminal。
- 深色主题优先。
- 侧边栏宽 220–280 px。
- 标签栏高 36–42 px。
- 终端区域填满剩余空间。
- 不使用大量圆角卡片。
- 不出现浏览器默认滚动条。
- 终端自身滚动。
- 使用 CSS variables 管理颜色。
- 当前 Project 与当前标签必须清晰可见。
- Local 与 SSH 项目图标不同。
- SSH 标签连接中显示 spinner。
- Error 和 Exited 状态应有轻量状态标识。
- 不在终端内容上覆盖大面积 UI。

根节点：

```css
html,
body,
#root {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
}
```

---

# 35. 测试要求

## 35.1 Rust 单元测试

至少测试：

- Local Project 路径验证。
- SSH Project 字段验证。
- Project JSON 序列化。
- Profile JSON 序列化。
- SSH Connection JSON 序列化。
- 空配置处理。
- 损坏配置处理。
- Shell 解析优先级。
- SSH Client 解析优先级。
- Session ID 不存在。
- resize 范围。
- Profile 必须属于 Project。
- SSH Connection 引用完整性。
- Conda 路径解析。
- PowerShell、CMD、Bash 转义。
- SSH 参数构建不使用字符串拼接。
- Host Key 安全配置不可被静默关闭。

## 35.2 前端 Store 测试

至少测试：

- 创建 Project Tab Group。
- 切换 Project。
- 恢复每个 Project 的 activeTabId。
- 同项目多标签命名。
- 不同项目标签隔离。
- 关闭 active tab 后选择相邻 tab。
- SSH exit 状态更新。
- Reconnect 创建新 Session。
- 默认 Profile 删除后的回退。
- 删除 Project 清理对应 Tabs。
- 删除 SSH Connection 的引用保护。

---

# 36. 手动验收测试

## 36.1 本地工作目录

添加：

```text
D:\Projects\TestProject
```

执行：

```powershell
Get-Location
```

预期为项目目录。

## 36.2 本地标签隔离

Project A Terminal 1：

```powershell
$env:TEST_VALUE = "A"
```

Project A Terminal 2：

```powershell
$env:TEST_VALUE
```

预期无 `A`。

## 36.3 Project 标签组隔离

- Project A 创建两个终端。
- Project B 创建三个终端。
- 切换 A 只显示两个。
- 切换 B 只显示三个。
- 切回 A 恢复上次激活标签。

## 36.4 后台运行

Project A：

```powershell
ping 127.0.0.1 -t
```

切换 Project B，再切回。

预期进程继续运行。

## 36.5 Conda

Profile：

```text
Conda Root: D:\program\anaconda
Environment: smolvla
```

执行：

```powershell
python -c "import sys; print(sys.executable)"
```

预期指向正确环境。

## 36.6 Conda 隔离

两个 Tab 分别使用不同 Conda Environment。

执行：

```powershell
python -c "import sys; print(sys.prefix)"
```

预期输出不同。

## 36.7 未执行 conda init

PowerShell 未初始化 Conda 时仍能通过 Hook 激活。

## 36.8 SSH Key 登录

创建 SSH Project，使用 key file。

预期：

- 成功连接。
- 进入 remotePath。
- 关闭标签页后 ssh.exe 退出。

## 36.9 SSH Agent 登录

使用系统 ssh-agent。

预期无需应用读取私钥。

## 36.10 SSH Password 登录

不保存密码。

预期密码提示在终端内出现，输入不被应用记录。

## 36.11 SSH Host Key 首次连接

预期显示 Fingerprint 并要求确认。

## 36.12 SSH Host Key 变化

预期阻止连接并显示高风险错误。

## 36.13 SSH Remote Path

远端 Linux：

```bash
pwd
```

预期为配置的 remotePath。

## 36.14 Remote Conda

SSH Profile 初始化：

```bash
source ~/miniconda3/etc/profile.d/conda.sh
conda activate smolvla
```

执行：

```bash
python -c "import sys; print(sys.prefix)"
```

预期为远端环境。

## 36.15 SSH Project 切换

- SSH Project A 中运行 `top` 或持续输出程序。
- 切换本地 Project。
- 再切回。

预期远程会话继续运行，不重新连接。

## 36.16 SSH 断线

断开网络或服务端终止连接。

预期：

- 标签变为 Exited/Error。
- 保留输出。
- 提供 Reconnect。
- 不无限重连。

## 36.17 Jump Host

配置一个可用 ProxyJump。

预期成功连接目标服务器。

## 36.18 中文路径

本地：

```text
D:\开发环境\机器学习\测试 项目
```

远端：

```text
/home/user/项目/测试 项目
```

预期正确进入路径。

## 36.19 Resize

本地和 SSH 标签都测试窗口调整。

预期远端全屏程序正确收到终端尺寸变化。

## 36.20 应用退出清理

打开多个：

- PowerShell。
- Conda。
- WSL。
- SSH。

退出应用。

预期任务管理器中不遗留对应子进程。

---

# 37. 实施阶段

## Phase 1：项目骨架

完成：

- Tauri 2 + React + TypeScript。
- Tailwind。
- shadcn/ui。
- AppLayout。
- 侧边栏占位。
- 标签栏占位。
- 终端区域占位。

验收：

```powershell
pnpm tauri dev
```

正常显示窗口。

## Phase 2：Project 与配置

完成：

- Project 模型。
- Local 与 SSH 类型。
- JSON Repository。
- Project CRUD。
- 配置安全写入。
- 侧边栏项目列表。
- 添加、编辑、删除 Local Project。
- SSH Project 表单占位。

验收：

- Local Project 可持久化。
- 无效路径不可保存。
- 重启后配置存在。

## Phase 3：单本地 PTY

完成：

- TerminalManager。
- create/write/resize/close。
- Tauri Channel。
- xterm.js。
- 单个 PowerShell。

验收：

- 输入输出正常。
- Ctrl+C 正常。
- resize 正常。

必须先稳定单 PTY，再做多标签。

## Phase 3.5：Terminal Profile

完成：

- Profile 模型。
- Profile CRUD。
- 默认 PowerShell Profile。
- Profile 环境变量。
- startup commands。
- `profileId` 创建终端。

验收：

- 同项目可有多个 Profile。
- 各 Profile 创建独立终端。

## Phase 3.6：Conda

完成：

- Conda 检测。
- `conda env list --json`。
- PowerShell Hook。
- CMD 激活。
- 名称和路径激活。
- 初始化错误保留 Shell。
- Test Profile。

验收：

- Conda 不在 PATH 仍可用。
- 未执行 `conda init` 仍可用。
- 多 Conda 环境隔离。

## Phase 3.7：其他环境

完成：

- venv。
- Poetry。
- uv。
- Custom activation。
- WSL 基础 Profile。

验收：

- 普通、Conda、venv 并存。
- 不同会话互不污染。

## Phase 4：Project 级标签页组

完成：

- `activeProjectId`。
- `tabsById`。
- `tabGroupsByProjectId`。
- 每个 Project 保存 activeTabId。
- Project 切换。
- 多标签。
- 关闭与重启。
- Empty State。

验收：

- 标签组严格隔离。
- 切换 Project 不关闭会话。
- 后台命令继续。

## Phase 5：SSH Connection 配置

完成：

- SSH Connection 模型。
- CRUD。
- SSH Client 检测。
- Host、Port、User、Key、Agent。
- Jump Host。
- Keepalive。
- Test Connection UI。
- Host Key 策略。

验收：

- 能保存 SSH Connection。
- 不保存密码。
- Key 路径验证。
- Host Key 检查开启。

## Phase 6：SSH 远程终端

完成：

- 在 PTY 中启动 `ssh.exe`。
- SSH 标签状态。
- Remote Path。
- 远端 Shell 初始化。
- SSH 输出与输入。
- SSH resize。
- 关闭和重连。

验收：

- SSH 交互式终端正常。
- 密码提示正常。
- Vim/top 等正常。
- Project 切换不重连。

## Phase 6.5：远端环境

完成：

- Remote Conda。
- Remote venv。
- Remote custom activation。
- 远端 Shell 类型转义。
- Remote Profile 测试。

验收：

- SSH Project 中可打开普通和 Conda 标签。
- 环境互相隔离。
- 初始化失败保留远端 Shell。

## Phase 7：侧边栏和交互完善

完成：

- 项目右键菜单。
- Profile 下拉菜单。
- Local Explorer。
- SSH Test/Reconnect。
- 删除引用保护。
- 状态数量。
- 错误 UI。

## Phase 8：稳定性与测试

完成：

- 退出清理。
- Reader 线程清理。
- 重复 close。
- Resize 防抖。
- Rust tests。
- Store tests。
- Windows 手动测试。
- SSH 安全测试。

## Phase 9：打包

```powershell
pnpm tauri build
```

验证：

- 安装包生成。
- AppData 配置。
- 中文路径。
- SSH Client 检测。
- 卸载不删除用户项目和远端文件。

---

# 38. 每阶段提交要求

每完成一个 Phase：

```powershell
pnpm format
pnpm lint
pnpm test

cargo fmt --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml

pnpm tauri dev
```

要求：

- 修复当前阶段错误再进入下一阶段。
- 每阶段独立 Git commit。
- 更新 README。
- 不通过关闭类型检查或大量 `any` 绕过问题。
- 不通过忽略 Rust error 或 panic 绕过问题。

建议提交：

```text
chore: initialize tauri react application
feat: add local and ssh project models
feat: add persistent terminal profiles
feat: implement portable pty terminal backend
feat: support conda terminal profiles
feat: add project scoped terminal tab groups
feat: add ssh connection management
feat: implement interactive ssh terminals
feat: support remote environment initialization
fix: clean up local and ssh sessions on exit
test: add project profile terminal and ssh coverage
build: configure windows installer
```

---

# 39. README 要求

README 必须包含：

- 项目用途。
- 当前功能。
- 技术栈。
- 开发环境。
- Node、Rust、Windows 依赖。
- Windows OpenSSH 要求。
- 安装命令。
- 开发命令。
- 构建命令。
- 目录结构。
- PTY 架构。
- Project Tab Group 架构。
- Terminal Profile 架构。
- Conda 初始化策略。
- SSH 安全策略。
- Host Key 行为。
- 配置文件位置。
- 密码和密钥处理方式。
- 已知限制。
- 后续计划。

---

# 40. Definition of Done

## Project

- [ ] 支持 Local Project。
- [ ] 支持 SSH Project。
- [ ] Project 配置持久化。
- [ ] SSH Connection 可被多个 Project 复用。
- [ ] Project 删除不会留下孤立 Session。
- [ ] 删除 SSH Connection 有引用保护。

## 标签页

- [ ] 每个 Project 有独立 Tab Group。
- [ ] 标签栏只显示当前 Project。
- [ ] 每个 Project 保存 activeTabId。
- [ ] 切换 Project 恢复上次标签。
- [ ] 切换 Project 不关闭 PTY。
- [ ] 切换 Project 不销毁 xterm。
- [ ] 后台命令继续运行。
- [ ] 同 Project 多标签互相独立。
- [ ] 不同 Project 标签互相隔离。

## 本地终端

- [ ] PowerShell 正常。
- [ ] CMD 正常。
- [ ] 自定义 Shell 正常。
- [ ] Git Bash 基础支持。
- [ ] WSL 基础支持。
- [ ] Ctrl+C、方向键、Tab 正常。
- [ ] resize 正常。
- [ ] 中文和空格路径正常。

## Environment

- [ ] Project 支持多个 Terminal Profile。
- [ ] 每个 Tab 保存 profileId。
- [ ] 普通终端 Profile。
- [ ] Conda Profile。
- [ ] venv Profile。
- [ ] Custom Profile。
- [ ] Poetry 基础支持。
- [ ] uv 基础支持。
- [ ] Conda 不在 PATH 时可配置。
- [ ] 未执行 conda init 时可激活。
- [ ] 支持环境名称和路径。
- [ ] 不同 Session 环境隔离。
- [ ] 切换 Tab 不重新激活。
- [ ] 初始化失败保留 Shell。
- [ ] 不自动安装或修改环境。

## SSH

- [ ] 可保存 SSH Connection。
- [ ] 可保存 SSH Project。
- [ ] 支持 Host、Port、Username。
- [ ] 支持 SSH Agent。
- [ ] 支持 Key File。
- [ ] 支持 Password 交互但不保存。
- [ ] 支持 Keyboard Interactive。
- [ ] 支持系统 SSH Config。
- [ ] 支持 Jump Host。
- [ ] 支持 Keepalive。
- [ ] 默认验证 Host Key。
- [ ] 首次 Host Key 要求确认。
- [ ] Host Key 变化时阻止连接。
- [ ] 支持 Remote Path。
- [ ] 支持远端 Shell。
- [ ] 支持远端 Conda。
- [ ] 支持远端 venv。
- [ ] SSH 标签支持 resize。
- [ ] SSH 断线显示状态。
- [ ] 提供 Reconnect。
- [ ] 切换 Project 不重新连接。
- [ ] 应用退出后不遗留 ssh.exe。

## 安全

- [ ] 无任意命令执行 API。
- [ ] 前端只传 projectId 和 profileId。
- [ ] 不保存 SSH 密码。
- [ ] 不复制私钥内容。
- [ ] 不记录终端输入。
- [ ] 不记录终端完整输出。
- [ ] 不记录 Token 和秘密。
- [ ] 不自动关闭 Host Key 检查。
- [ ] 不修改全局环境。
- [ ] Tauri 权限最小化。

## 构建

- [ ] Rust tests 通过。
- [ ] TypeScript 检查通过。
- [ ] 前端 tests 通过。
- [ ] `pnpm tauri build` 成功。
- [ ] README 完整。
- [ ] Windows 安装包可运行。
- [ ] 应用退出清理所有子进程。

---

# 41. Agent 执行规则

Agent 必须遵守：

1. 按 Phase 顺序实施。
2. 开始前检查现有仓库和配置。
3. 不覆盖已有有效代码。
4. 先完成最小稳定路径。
5. 单 PTY 稳定后才做多标签。
6. 本地终端稳定后再做 SSH。
7. Profile 是一级模型。
8. Project Tab Group 是一级模型。
9. SSH Connection 是一级模型。
10. 不把 Conda 逻辑写在 React 组件。
11. 不把 SSH 命令拼接写在 React 组件。
12. Environment 解析放在 Rust。
13. SSH 参数构建放在 Rust。
14. 使用参数数组，不使用危险字符串拼接。
15. 不依赖用户已经执行 `conda init`。
16. 不使用全局环境模拟 Conda。
17. 不使用 `conda run` 替代完整交互终端。
18. 切换 Project 或 Tab 不重新初始化环境。
19. 切换 Project 或 Tab 不重新连接 SSH。
20. 每个 Tab 对应独立 PTY。
21. 每个 SSH Tab 对应独立 ssh.exe。
22. 输出按 sessionId 路由。
23. 不自动接受 SSH Host Key。
24. 不保存 SSH 密码。
25. 初始化失败时保留可操作 Shell。
26. 不自动创建或修改本地、远端环境。
27. 不提前实现 AI、分屏、SFTP 或插件系统。
28. 遇到版本差异以当前依赖类型和编译错误为准。
29. 不通过 `any`、禁用 lint 或忽略错误解决问题。
30. 每阶段运行格式化、检查和测试。
31. 当前阶段通过后再进入下一阶段。
32. 每阶段创建独立 commit。
33. 最终输出：
    - 修改文件列表。
    - 架构说明。
    - 启动命令。
    - 测试结果。
    - 已知限制。
    - 安全说明。
    - 后续建议。

---

# 42. Agent 开始指令

现在从以下顺序开始：

```text
Phase 1：项目骨架
Phase 2：Project 与配置
Phase 3：单本地 PTY
Phase 3.5：Terminal Profile
Phase 3.6：Conda
Phase 3.7：其他环境
Phase 4：Project 级标签页组
Phase 5：SSH Connection 配置
Phase 6：SSH 远程终端
Phase 6.5：远端环境
Phase 7：交互完善
Phase 8：稳定性与测试
Phase 9：打包
```

开始执行前：

1. 列出现有目录。
2. 检查 `package.json`。
3. 检查 `src-tauri/Cargo.toml`。
4. 检查 Tauri 版本。
5. 检查当前代码是否已有终端、Project 或状态管理实现。
6. 给出本阶段将修改的文件。
7. 直接开始实现当前阶段，不要一次跳过多个阶段。

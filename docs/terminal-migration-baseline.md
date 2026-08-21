# Terminal engine migration baseline

Date: 2026-08-22 (Australia/Sydney)

Branch: refactor/wezterm-term-engine

Historical comparison checkpoint: bcd2a41 (before runtime cleanup)

## Historical pre-migration architecture

The following records the baseline architecture reviewed before the Rust-owned
terminal model was enabled. It is retained to define the comparison surface;
it is not the architecture shipped by this branch.

```text
ConPTY
  -> portable-pty
  -> TerminalSession reader
  -> TerminalEvent::Output(Bytes)
  -> Tauri Channel
  -> frontend output queue
  -> xterm parser, buffer, and scrollback
  -> DOM/WebGL addon renderer
```

At that point VT parsing, screen state, alternate-screen state, selection,
search, and cell rendering were owned by the JavaScript terminal runtime.

## Current authoritative architecture

```text
ConPTY / remote SSH or WSL process
  -> portable-pty
  -> TerminalSession
  -> WeztermTerminalEngine
       (wezterm-term parser, screen, scrollback, modes, images)
  -> TerminalFrameHub, coalesced at approximately 16 ms
  -> typed RenderFrame and ControlEvent messages
  -> Tauri Channel
  -> Canvas2D or WebGL2 renderer
  -> React UI attachment
```

The frontend no longer parses ANSI/VT bytes and does not maintain a second
screen buffer. React owns tabs, panes, settings, and attachment lifecycle;
Rust owns the PTY, terminal model, scrollback, control events, and input
encoding.

## Responsibility map

| Concern                                                  | Authoritative owner                        | Notes                                                   |
| -------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| ConPTY, process spawn, stdin/stdout, resize, kill        | portable-pty and TerminalSession           | The PTY boundary is unchanged.                          |
| VT/ANSI parsing, screen, alternate screen, cursor, modes | wezterm-term through WeztermTerminalEngine | One model per terminal session.                         |
| Scrollback and stable rows                               | wezterm-term                               | The old raw ring and replay stream are removed.          |
| Keyboard, mouse, paste, and IME encoding                 | WeztermTerminalEngine                      | Frontend sends semantic events.                         |
| OSC title, cwd, command markers, bell                    | engine control event queue                 | Only changes are sent; not repeated per frame.          |
| Render transport                                         | TerminalFrameHub and typed Tauri frames    | Dirty rows, sequence numbers, and full snapshots.       |
| Cell drawing and metrics                                 | replaceable Canvas2D/WebGL2 renderer       | No React element per cell.                              |
| Search and selection                                     | Rust model queries                         | Results use stable rows and cell columns.               |
| React project/tab/split lifecycle                        | React and Zustand                          | Detaching a renderer never kills the session.           |
| Remote terminal                                          | Rust render frames plus remote_renderer.js | Semantic input and the same model-owned frame contract. |

## Migration invariants

- portable-pty and the Windows ConPTY path remain the process boundary.
- WeztermTerminalEngine is the only authoritative terminal model.
- A PTY read does not imply an IPC message; dirty state is frame-batched.
- A frame contains only changed rows unless a full snapshot is requested.
- Renderer attachment is independent of PTY/model lifetime.
- A background session keeps reading, parsing, and bounded model scrollback, but has
  no continuous frame subscriber.
- The model sequence used for dirty-row extraction is separate from the
  monotonic IPC sequence used for resync ordering.
- Render/control transport is distinct from status, exit, bell, title, cwd,
  and command-finished events.
- The legacy raw OutputRingBuffer, raw session subscriptions, and raw PTY replay
  path have been removed; startup probes and diagnostics now query the
  authoritative wezterm model or typed control/status streams.

## Implemented compatibility surface

The current branch has deterministic coverage for:

- PowerShell and cmd process/session lifecycle paths, including resize and
  exit handling; optional WSL and SSH use the same session/model boundary.
- ANSI colors, 256-color and truecolor attributes, cursor styles, hyperlinks,
  wide cells, combining text, CJK, emoji, and Nerd Font glyph measurement.
- Alternate screen, cursor visibility, mouse reporting, bracketed paste,
  application cursor/keypad modes, and semantic composition text.
- OSC 0/2 title, OSC 7 cwd, OSC 8 hyperlinks, OSC 133 command completion,
  bell control events, and stale-state-safe full snapshots.
- Rust-owned search and selection text over stable scrollback rows.
- Dirty-row frames, frame coalescing, sequence-guarded lag recovery, image
  cache identities, theme/palette conversion, and viewport resync.
- Remote renderer input/frame protocol without bundled JavaScript terminal
  parser assets.
- React unmount/detach behavior that leaves the PTY and Rust model alive.

Desktop renderer choices are replaceable through TerminalRenderer. Canvas2D
is the correctness fallback. The WebGL2 path uses a bounded Canvas2D-rasterized
glyph atlas, preserves browser-rasterized color glyphs such as emoji, batches
cell backgrounds and glyph quads on the GPU, and uses a transparent Canvas2D
overlay for image protocols, combining/decorative details, links, selection
treatment, and cursor drawing. Atlas exhaustion restores the complete Canvas2D
path rather than dropping text.

## Dependency state

- All @xterm/* runtime dependencies and frontend xterm-specific queues/addons
  are removed.
- The Rust dependency is wezterm-term from the exact pinned revision:

```text
770d8e1a7519a9a698090cd7d717d0c64aa0a755
```

- Rust MSRV remains 1.77.2. The local verification toolchain is Rust 1.96.
- wezterm-term and the directly used upstream crates are MIT licensed; the
  repository attribution is recorded in THIRD_PARTY_NOTICES.

## Verification status

Deterministic checks run during migration:

```text
Frontend: tsc -b, Vite production build, ESLint, Prettier check, and Vitest
(37 files, 240 tests).
Rust: cargo fmt, cargo check, cargo clippy, and cargo test (314 passed, 3
ignored stress/profiling probes). The 10-session probe was also run separately
with `--ignored` and passed.
```

The real PowerShell handshake probe uses the inbox `powershell.exe` explicitly
so a managed-environment PATH shim cannot replace the shell under test. It
passes in the current Windows environment; a slow shell remains an
environment-sensitive integration boundary.

## Performance measurement status

GUI startup, prompt time, CPU, RAM, renderer FPS, input latency, and IPC volume
must be measured on Windows rather than inferred from unit tests. The required
matrix is:

| Case                                             | Required measurements                                |
| ------------------------------------------------ | ---------------------------------------------------- |
| PowerShell, cmd, optional WSL                    | create-to-prompt, first input latency                |
| Synthetic large output and real build/log output | throughput, CPU, RAM, frame count, IPC bytes         |
| 1, 5, and 10 sessions                            | active/background CPU and RAM                        |
| Four visible split panes                         | frame rate, queue depth, input latency               |
| 100+ rapid resizes                               | final PTY/model/renderer grid dimensions and latency |

The ignored Rust stress fixtures cover parser/scrollback bounds and render-frame
serialization. They are repeatable correctness/throughput probes, not a claim
that GUI acceptance has already been measured. Results should be appended to
the migration benchmark record with OS build, commit, renderer preference,
font, rows/columns, and whether the session was active or background.

The first local engine probe on commit bcd2a41 used the debug profile and an
8 MiB synthetic stream. It reported approximately 33.1 s for parsing, 150 us
for frame extraction, 0.4 ms for JSON serialization, four dirty rows, a
6,411-byte frame, and a bounded 10,000-row scrollback. This is useful as a
repeatability check for the Rust model only; it is not a desktop GUI baseline.

The release-profile harness was rerun on 2026-08-22 after the renderer cleanup.
Across its two Cargo test targets it reported 462--467 ms for parsing, 20 us
for frame extraction, 41--45 us for JSON serialization, four dirty rows, the
same 6,411-byte frame, and the same 10,000-row scrollback. The duplicate lines
are the repository's intentional lib/integration-test target layout.

The standalone browser renderer harness at
`scripts/terminal-renderer-benchmark.html` was run in Chrome/WebView-compatible
Chromium 151 on the same Windows build. With a 601 x 320 CSS-pixel surface,
96 columns, 18 rows, dirty updates, CJK, combining marks, emoji, selection, and
decorations, WebGL2 stayed enabled for 3.004 s, processed 180 input frames and
180 browser frames (60 FPS), and spent 0.60 ms in scheduled WebGL render calls
versus 0.10 ms for Canvas2D. The screenshot was visually compared with the
Canvas2D fallback; color emoji and the selected/search-highlighted cells
remained visible in both paths. This is a renderer-only measurement and does
not claim PTY or Tauri GUI coverage.

An elevated release-build GUI smoke probe was also run on 2026-08-22. The
Tauri window was visible with the restored project title, retained a valid
window handle and remained responsive for 30 seconds. During a 10-second idle
sample, the process plus its WebView2 child used approximately 184.1 MiB and
consumed 0.016 CPU seconds. This validates startup/window stability and idle
resource behavior only; it is not the active/background terminal matrix.

The repeatable GUI matrix at `scripts/terminal-gui-performance.ps1` then
created real PTY sessions through the visible Tauri UI with bundled `pwsh`,
kept the final tab active, and verified one canvas/input attachment while the
remaining sessions were background models. Each row below uses a 10-second
idle sample; CPU is reported as a percentage of one logical core and memory is
the complete Tauri + WebView2 + PTY process tree:

| sessions | shell processes | canvas/input attachments | CPU seconds | CPU % of one core | working set |
| -------- | --------------- | ------------------------ | ----------- | ----------------- | ----------- |
| 1        | 1               | 1 / 1                    | 0.219       | 2.19%             | 703.8 MiB  |
| 5        | 5               | 1 / 1                    | 0.797       | 7.97%             | 1,181.7 MiB|
| 10       | 10              | 1 / 1                    | 1.141       | 11.41%            | 1,737.1 MiB|

All three cases exited through the application quit flow and returned
`CleanExit=true`. This completes the current idle active/background matrix;
historical xterm/WebGL comparison, active output throughput, input latency,
split-pane, and rapid-resize measurements remain separate acceptance items.

The formal Windows release build was rerun with the Tauri `custom-protocol`
feature on 2026-08-22. `pnpm tauri build --bundles nsis --no-sign` completed
and produced the current exe and NSIS installer. A normal elevated
`pnpm tauri bundle --bundles msi --verbose --no-sign` run also completed: WiX
ICE validation passed with the expected ICE03/ICE40/ICE57/ICE61 warnings and
produced the current MSI installer. A prior non-elevated run failed with WiX
LGHT0217/LGHT0216 because the managed Windows Installer Service could not be
accessed; that diagnostic failure is not a project packaging failure.
No updater signatures were generated because `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are unavailable in the environment.

The ignored Windows multi-session probe spawned ten independent `cmd.exe`
sessions, attached one frame subscriber, left nine sessions without renderer
subscribers, and wrote/search-verified a distinct marker in every model. All
ten stayed running and the probe completed in 484 ms with
`active_renderers=1 background_renderers=9`. It verifies session/model
isolation and background parsing, but it does not replace the GUI CPU/RAM
matrix.

The 100MiB scrollback stress probe was rerun with a 24 x 80 terminal so its
final marker remains on one physical row. It passed in 219.87 s, kept the
scrollback at the configured bound, and found the final marker through the
Rust-owned search path.

## Remaining acceptance work

- Compare the measured GUI matrix against the historical xterm/WebGL baseline
  and add active large-output throughput, input latency, four-pane rendering,
  and rapid-resize samples. The non-elevated managed desktop session still
  fails WebView2 creation with `0x800700AA` (resource in use); the matrix was
  collected in the elevated interactive session.
- Run a signed release build when TAURI_SIGNING_PRIVATE_KEY is available.
- Keep the xterm terminology in this document only where it identifies the
  historical baseline or the required comparison.

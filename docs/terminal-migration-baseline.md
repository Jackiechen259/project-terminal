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

| Concern | Authoritative owner | Notes |
| --- | --- | --- |
| ConPTY, process spawn, stdin/stdout, resize, kill | portable-pty and TerminalSession | The PTY boundary is unchanged. |
| VT/ANSI parsing, screen, alternate screen, cursor, modes | wezterm-term through WeztermTerminalEngine | One model per terminal session. |
| Scrollback and stable rows | wezterm-term | The old raw ring is compatibility/debug only. |
| Keyboard, mouse, paste, and IME encoding | WeztermTerminalEngine | Frontend sends semantic events. |
| OSC title, cwd, command markers, bell | engine control event queue | Only changes are sent; not repeated per frame. |
| Render transport | TerminalFrameHub and typed Tauri frames | Dirty rows, sequence numbers, and full snapshots. |
| Cell drawing and metrics | replaceable Canvas2D/WebGL2 renderer | No React element per cell. |
| Search and selection | Rust model queries | Results use stable rows and cell columns. |
| React project/tab/split lifecycle | React and Zustand | Detaching a renderer never kills the session. |
| Remote terminal | Rust render frames plus remote_renderer.js | Semantic input and the same model-owned frame contract. |

## Migration invariants

- portable-pty and the Windows ConPTY path remain the process boundary.
- WeztermTerminalEngine is the only authoritative terminal model.
- A PTY read does not imply an IPC message; dirty state is frame-batched.
- A frame contains only changed rows unless a full snapshot is requested.
- Renderer attachment is independent of PTY/model lifetime.
- A background session keeps reading, parsing, and bounded scrollback, but has
  no continuous frame subscriber.
- The model sequence used for dirty-row extraction is separate from the
  monotonic IPC sequence used for resync ordering.
- Render/control transport is distinct from status, exit, bell, title, cwd,
  and command-finished events.
- Raw OutputRingBuffer and raw session subscriptions remain only for backend
  startup probes, diagnostics, and comparison tests; no frontend terminal
  renderer consumes them.

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
glyph atlas, GPU-batched cell backgrounds and glyph quads, and a transparent
Canvas2D overlay for image protocols, combining/decorative details, links,
selection treatment, and cursor drawing. Atlas exhaustion restores the complete
Canvas2D path rather than dropping text.

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
Rust: cargo fmt, cargo check, cargo clippy, and cargo test (324 passed, 2
ignored stress/profiling probes).
```

The real PowerShell handshake probe uses the inbox `powershell.exe` explicitly
so a managed-environment PATH shim cannot replace the shell under test. It
passes in the current Windows environment; a slow shell remains an
environment-sensitive integration boundary.

## Performance measurement status

GUI startup, prompt time, CPU, RAM, renderer FPS, input latency, and IPC volume
must be measured on Windows rather than inferred from unit tests. The required
matrix is:

| Case | Required measurements |
| --- | --- |
| PowerShell, cmd, optional WSL | create-to-prompt, first input latency |
| Synthetic large output and real build/log output | throughput, CPU, RAM, frame count, IPC bytes |
| 1, 5, and 10 sessions | active/background CPU and RAM |
| Four visible split panes | frame rate, queue depth, input latency |
| 100+ rapid resizes | final PTY/model/renderer grid dimensions and latency |

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
Across its two Cargo test targets it reported 455--494 ms for parsing, 26--29
us for frame extraction, 75--83 us for JSON serialization, four dirty rows,
the same 6,411-byte frame, and the same 10,000-row scrollback. The duplicate
lines are the repository's intentional lib/integration-test target layout.

## Remaining acceptance work

- Collect the Windows GUI performance matrix above against the historical
  xterm/WebGL baseline.
- Profile the WebGL2 glyph-atlas path against the historical WebGL baseline and
  tune atlas size, batch bytes, and fallback thresholds for real workloads.
- Run a signed release build when TAURI_SIGNING_PRIVATE_KEY is available.
- Keep the xterm terminology in this document only where it identifies the
  historical baseline or the required comparison.

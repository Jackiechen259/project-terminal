# Terminal engine migration baseline

Date: 2026-08-22 (Australia/Sydney)

Branch: `refactor/wezterm-term-engine`

Baseline commit: `d4bb44c`

## Current data flow

```text
portable-pty / ConPTY
  -> TerminalSession reader thread
  -> TerminalEvent::Output(Bytes)
  -> tokio broadcast channel
  -> Tauri Channel<InvokeResponseBody>
  -> TerminalOutputQueue
  -> xterm.write()
  -> xterm parser + buffer + scrollback
  -> DOM/WebGL addon renderer
```

The backend already keeps the PTY and reader alive without an attachment. It
also keeps bounded raw-byte scrollback and resize boundaries, and sends a
`lagged` control frame when a frontend subscriber falls behind. The terminal
model, VT parser, screen buffer, search, selection, OSC handling, image state,
and renderer still belong to xterm.js.

## Responsibility map

| Concern | Current owner | Migration destination |
| --- | --- | --- |
| ConPTY, process spawn, stdin/stdout, resize, kill | `portable-pty` and `terminal/session.rs` | Keep unchanged at the PTY boundary |
| Raw transport, attachment, status, lag recovery | `TerminalSession`, `TerminalManager`, `commands/terminal.rs` | Typed render/control transport; session lifecycle remains backend-owned |
| VT/ANSI parsing, screen, alternate screen, cursor, scrollback | xterm.js | `wezterm-term` inside Rust |
| OSC 7/133/title and hyperlink events | xterm parser callbacks plus frontend helpers | WezTerm terminal notifications plus a minimal side channel only where required |
| Search and selection | xterm addons/core | Rust engine queries and renderer coordinates |
| Cell drawing and font metrics | xterm DOM/WebGL | Replacable Canvas2D/WebGL renderer |
| React tab/split/project lifecycle | React/Zustand | Keep; renderer attachment must stay separate from PTY session |
| Remote mobile terminal | bundled xterm assets in `src-tauri/src/remote` | Separate migration surface; do not remove until a compatible remote protocol/renderer exists |

## Pre-migration baseline verification

### Rust

Command:

```text
cargo test --manifest-path src-tauri/Cargo.toml
```

Result: compilation succeeded; 296 of 297 unit/integration tests passed. The
single failure was the existing real PowerShell handshake probe:

```text
commands::terminal::handshake_probe::a_real_powershell_session_shows_no_encoding_command
EnvironmentInitializationFailed("Timed out waiting for the interactive shell")
```

The failure occurred before any migration changes and should remain a known
environment-sensitive baseline until it can be reproduced or fixed
independently.

### Frontend

`pnpm test` first stopped because pnpm refused to recreate `node_modules` in a
non-interactive shell. Retrying with `CI=true` started a dependency rebuild but
made no progress for more than two minutes and was interrupted. No frontend
test result was claimed by the original baseline because the dependency tree
was incomplete at that point. That is a historical note; the current
migration checkout has since reinstalled dependencies and passed the frontend
suite.

## Migration checkpoint

The branch now contains a parallel, development-only WezTerm path selected by
`VITE_TERMINAL_ENGINE=wezterm`. The old path remains the default until feature
parity and performance acceptance are complete.

The new path is:

```text
portable-pty / ConPTY
  -> TerminalSession reader
  -> wezterm-term Terminal model
  -> 16 ms Rust frame scheduler
  -> sequence-numbered dirty RenderFrame / control events
  -> Tauri Channel
  -> Canvas2D renderer with requestAnimationFrame coalescing
```

Implemented in this checkpoint:

- Rust-owned VT parsing, screen, alternate screen, scrollback, cursor,
  hyperlinks, ANSI attributes, images, keyboard/mouse encoding, paste mode,
  semantic text/IME input, OSC title/cwd (including clearing a stale cwd), and
  the minimal OSC 133
  command-finished side channel.
- Stable-row viewport requests, Rust-owned search results, dirty-row frames,
  sequence-guarded full-snapshot recovery, and renderer attachment independent
  of PTY lifetime.
- Desktop session creation now passes the existing visible scrollback-row
  setting directly to wezterm-term while retaining the raw-byte attach-history
  budget as a separate compatibility limit.
- Renderer attachments use a status-only lifecycle channel; they do not
  subscribe to the legacy raw-output broadcast while rendering.
- Full-snapshot resyncs replay only current title/cwd state, not stale
  detached-session bell or command-completion edges; backend resize requests
  are deduplicated across grid and pixel dimensions.
- Canvas2D text/attribute/cursor/selection rendering with DPR-aware metrics,
  image cache loading, plain-link detection, minimum-contrast handling,
  configurable cursor styles/blink, frame coalescing, and a transient visual
  bell for the typed bell control event.

The following are intentionally still open: WebGL renderer, remote terminal
protocol migration, full viewport virtualization, performance measurements,
and removal of xterm runtime dependencies.

Current deterministic checks:

```text
Frontend: tsc -b, ESLint, CanvasRenderer tests, and the full Vitest suite pass.
Rust: 320 tests passed serially with one intentionally ignored 100MB stress
fixture. This includes live `cmd.exe` renderer attachment, status delivery,
background-model, semantic text input, and scrollback-setting tests. A prior
parallel run timed out in the existing real PowerShell handshake probe; the
latest full serial run passes with `--test-threads=1`. The 100MB fixture still
requires a separate profiling run.
```

### Runtime performance

No GUI terminal session was launched in this environment, so startup prompt
time, CPU, RAM, renderer FPS, input latency, and IPC volume are intentionally
recorded as **not measured**, not guessed. The migration must add a repeatable
measurement harness before performance acceptance is declared. Required cases
are PowerShell, cmd, optional WSL, synthetic large output, and 1/5/10 session
foreground/background configurations.

## Upstream dependency check

The upstream `wezterm-term` package is currently a git workspace crate named
`wezterm-term`, version `0.1.0`, licensed MIT. Its public entry point exposes
`Terminal::new`, `advance_bytes`, `TerminalState`, `Screen`, `Line`,
`SequenceNo`, keyboard/mouse encoding, scrollback, sixel, iTerm2 images,
OSC 8 hyperlinks, and terminal cell attributes. It does not own a GUI or PTY.

The checked upstream main revision is pinned for this migration to:

```text
770d8e1a7519a9a698090cd7d717d0c64aa0a755
```

The upstream build documentation states Rust 1.71 or later is required; this
repository's declared MSRV remains Rust 1.77.2 until a local dependency build
proves otherwise. The available local toolchain is Rust 1.96.0. If Cargo or CI
shows that this exact revision requires a newer MSRV, the `rust-version` field
will not be changed silently.

## Migration guardrails

- `portable-pty` and the existing ConPTY path remain the process boundary.
- The old xterm path remains available during comparison, but it cannot remain
  a second authoritative model after the WezTerm engine is enabled by default.
- PTY reader rate is not allowed to dictate IPC frame rate; render frames must
  be sequence-numbered, dirty-row based, and frame-batched.
- Detaching a renderer must not kill or pause the PTY/model session.
- Existing shell, TUI, image, search, clipboard, theme, IME, remote, and split
  pane behavior must be covered before deleting xterm runtime dependencies.

# Changelog

## Unreleased

### Fixed

- Forwarded mouse motion to TUI apps that enable any-event tracking (DECSET 1003), including hover, and filled in cell pixel offsets for SGR pixel mouse.
- Reported terminal focus in/out (DECSET 1004) so vim/nvim-style TUIs know when the pane is active.
- Let Ctrl+PageUp/PageDown and Ctrl+1–9 reach full-screen TUIs instead of switching tabs.
- Enabled Kitty graphics decoding by default so agent/TUI image output is not dropped.
- Copied OSC 52 clipboard writes from TUI apps (capped at 1 MiB) to the native clipboard.
- Passed the pane's pixel size when creating a session so image protocols do not start at 0×0.
- Parked the IME caret on the cursor cell and drew pinyin preedit there so Chinese composition no longer sits at the top-left, and committed composed text once without a leftover Enter or Space.
- Held TUI redraws wrapped in DECSET 2026 until the frame ended (or 150ms elapsed) so spinners and live dashboards no longer tear mid-update, and advertised the mode to apps that query it.
- Played kitty/GIF animation frames on the overlay instead of freezing on the first frame.
- Blinked SGR 5/6 text instead of dropping the blink attribute.

## [0.6.3] - 2026-09-06

### Performance

- Compacted adjacent same-style terminal cells into runs so agent TUI full-screen redraws send far less JSON per frame.
- Held frame extraction until the previous frame was consumed, so a slow renderer accumulates dirty rows instead of overflowing the channel and forcing full snapshots.
- Recycled the WebGL glyph atlas instead of falling back to Canvas2D when agent TUIs introduce many unique glyphs, rasterized compacted runs per cluster so unique strings do not fill the atlas, and skipped colour-emoji detection for ASCII.
- Paused render-frame delivery for hidden subscribers while keeping control events live, and requested a full snapshot when a terminal becomes visible again.
- Mounted terminal renderer views only after a pane was first visible, so restoring many tabs no longer creates a WebGL context per hidden session.
- Painted selection and search highlights on the Canvas overlay instead of rebuilding the GPU grid on every pointermove.
- Skipped project file listings while the Files panel is hidden behind Memos.

### Fixed

- Sent Num Lock keypad digits and decimal input to the terminal as text instead of navigation escape sequences.

## [0.6.2] - 2026-09-06

### Fixed

- Routed terminal selection copy through the native Windows clipboard so right-click copy works reliably.
- Made terminal right-click paste work when the click leaves only a collapsed selection.
- Added Unicode clipboard round-trip and terminal context-menu regression coverage.

## [0.6.1] - 2026-09-01

### Fixed

- Preserved terminal render-frame consistency across tab switches, viewport changes, and renderer resizes.
- Prevented the light-theme flash shown while switching terminal tabs.
- Retained terminal renderer instances across tab switches so existing output stays visible.
- Kept live terminal render streams active across hidden tabs so output resumes without stale frames.

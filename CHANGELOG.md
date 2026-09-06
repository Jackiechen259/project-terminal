# Changelog

## Unreleased

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

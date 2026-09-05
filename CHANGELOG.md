# Changelog

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

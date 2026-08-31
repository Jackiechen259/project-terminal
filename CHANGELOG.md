# Changelog

## [0.6.1] - 2026-09-01

### Fixed

- Preserved terminal render-frame consistency across tab switches, viewport changes, and renderer resizes.
- Prevented the light-theme flash shown while switching terminal tabs.
- Retained terminal renderer instances across tab switches so existing output stays visible.
- Kept live terminal render streams active across hidden tabs so output resumes without stale frames.

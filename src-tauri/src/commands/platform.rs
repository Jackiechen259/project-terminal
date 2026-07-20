//! Platform capability Tauri command.
//!
//! Returns a one-shot snapshot of what the host supports: which project types
//! are creatable, which local shells the picker should offer, and the default
//! shell for a freshly created local project. The frontend loads this once on
//! startup and drives all platform-conditional UI from it - components MUST
//! NOT hardcode `cfg!(windows)` style checks.

use crate::platform::PlatformInfo;

#[tauri::command]
pub fn get_platform_info() -> PlatformInfo {
    PlatformInfo::current()
}

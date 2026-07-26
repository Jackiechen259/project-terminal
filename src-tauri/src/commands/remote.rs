use tauri::State;

use crate::remote::RemoteGateway;

#[tauri::command]
pub fn remote_access_info(remote: State<'_, RemoteGateway>) -> serde_json::Value {
    remote.info()
}

#[tauri::command]
pub fn set_remote_lan_access(
    remote: State<'_, RemoteGateway>,
    allow_lan: bool,
) -> Result<serde_json::Value, String> {
    remote
        .reconfigure(allow_lan)
        .map_err(|error| error.to_string())?;
    Ok(remote.info())
}

#[tauri::command]
pub fn set_remote_enabled(
    remote: State<'_, RemoteGateway>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    remote
        .set_enabled(enabled)
        .map_err(|error| error.to_string())?;
    Ok(remote.info())
}

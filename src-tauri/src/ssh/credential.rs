//! Secure storage and OpenSSH askpass integration for saved SSH passwords.
//!
//! Passwords are stored in Windows Credential Manager and are never written
//! to connection JSON, command arguments, environment values, or logs.

use crate::error::{AppError, AppResult};

const CREDENTIAL_TARGET_PREFIX: &str = "ProjectTerminal/SSH/";
const ASKPASS_CONNECTION_ENV: &str = "PROJECT_TERMINAL_SSH_CREDENTIAL_ID";

fn target_name(connection_id: &str) -> String {
    format!("{CREDENTIAL_TARGET_PREFIX}{connection_id}")
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn last_os_error() -> AppError {
    AppError::Io(std::io::Error::last_os_error())
}

#[cfg(windows)]
pub fn save_password(connection_id: &str, password: &str) -> AppResult<()> {
    use windows_sys::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    let target = wide(&target_name(connection_id));
    let mut password_bytes = password.as_bytes().to_vec();
    let blob_size = u32::try_from(password_bytes.len()).map_err(|_| {
        AppError::Configuration("The SSH password is too large to save securely".into())
    })?;
    let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = target.as_ptr() as *mut u16;
    credential.CredentialBlobSize = blob_size;
    credential.CredentialBlob = password_bytes.as_mut_ptr();
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;

    let written = unsafe { CredWriteW(&credential, 0) };
    password_bytes.fill(0);
    if written == 0 {
        return Err(last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn save_password(_connection_id: &str, _password: &str) -> AppResult<()> {
    Err(AppError::Configuration(
        "Secure SSH password storage is currently available on Windows only".into(),
    ))
}

#[cfg(windows)]
pub fn read_password(connection_id: &str) -> AppResult<Option<String>> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target = wide(&target_name(connection_id));
    let mut pointer: *mut CREDENTIALW = std::ptr::null_mut();
    let read = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) };
    if read == 0 {
        let error = unsafe { GetLastError() };
        if error == ERROR_NOT_FOUND {
            return Ok(None);
        }
        return Err(AppError::Io(std::io::Error::from_raw_os_error(
            error as i32,
        )));
    }

    let password = unsafe {
        let credential = &*pointer;
        let bytes = std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        );
        String::from_utf8(bytes.to_vec()).map_err(|_| {
            AppError::Configuration("The saved SSH password is not valid UTF-8".into())
        })
    };
    unsafe { CredFree(pointer.cast()) };
    password.map(Some)
}

#[cfg(not(windows))]
pub fn read_password(_connection_id: &str) -> AppResult<Option<String>> {
    Ok(None)
}

pub fn password_exists(connection_id: &str) -> AppResult<bool> {
    password_exists_inner(connection_id)
}

#[cfg(windows)]
fn password_exists_inner(connection_id: &str) -> AppResult<bool> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };

    let target = wide(&target_name(connection_id));
    let mut pointer: *mut CREDENTIALW = std::ptr::null_mut();
    let read = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) };
    if read != 0 {
        unsafe { CredFree(pointer.cast()) };
        return Ok(true);
    }
    let error = unsafe { GetLastError() };
    if error == ERROR_NOT_FOUND {
        Ok(false)
    } else {
        Err(AppError::Io(std::io::Error::from_raw_os_error(
            error as i32,
        )))
    }
}

#[cfg(not(windows))]
fn password_exists_inner(_connection_id: &str) -> AppResult<bool> {
    Ok(false)
}

#[cfg(windows)]
pub fn delete_password(connection_id: &str) -> AppResult<()> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NOT_FOUND};
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

    let target = wide(&target_name(connection_id));
    let deleted = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
    if deleted == 0 {
        let error = unsafe { GetLastError() };
        if error != ERROR_NOT_FOUND {
            return Err(AppError::Io(std::io::Error::from_raw_os_error(
                error as i32,
            )));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn delete_password(_connection_id: &str) -> AppResult<()> {
    Ok(())
}

/// Environment inherited by OpenSSH and then by this executable when it is
/// launched as SSH_ASKPASS. The secret itself is never placed in the env.
pub fn askpass_environment(connection_id: &str) -> AppResult<Vec<(String, String)>> {
    let executable = std::env::current_exe().map_err(AppError::Io)?;
    Ok(vec![
        (
            "SSH_ASKPASS".into(),
            executable.to_string_lossy().into_owned(),
        ),
        ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
        ("DISPLAY".into(), "project-terminal".into()),
        (ASKPASS_CONNECTION_ENV.into(), connection_id.to_string()),
    ])
}

fn is_host_confirmation_prompt(prompt: &str) -> bool {
    let prompt = prompt.to_ascii_lowercase();
    prompt.contains("yes/no") || prompt.contains("authenticity of host")
}

fn is_password_prompt(prompt: &str) -> bool {
    let prompt = prompt.to_ascii_lowercase();
    prompt.contains("password") || prompt.contains("passcode")
}

#[cfg(windows)]
fn confirm_host(prompt: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDYES, MB_ICONWARNING, MB_YESNO,
    };

    let title = wide("Project Terminal - SSH host verification");
    let body = wide(prompt);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONWARNING,
        ) == IDYES
    }
}

#[cfg(not(windows))]
fn confirm_host(_prompt: &str) -> bool {
    false
}

/// Returns an exit code when this process was launched by OpenSSH as its
/// askpass helper, or `None` for a normal application launch.
pub fn askpass_exit_code() -> Option<i32> {
    use std::io::Write;

    let connection_id = std::env::var(ASKPASS_CONNECTION_ENV).ok()?;
    let prompt = std::env::args().nth(1).unwrap_or_default();

    if is_host_confirmation_prompt(&prompt) {
        let answer = if confirm_host(&prompt) {
            "yes\n"
        } else {
            "no\n"
        };
        return Some(
            std::io::stdout()
                .write_all(answer.as_bytes())
                .map(|_| 0)
                .unwrap_or(1),
        );
    }
    if !is_password_prompt(&prompt) {
        return Some(1);
    }

    let Ok(Some(mut password)) = read_password(&connection_id) else {
        return Some(1);
    };
    let result = std::io::stdout()
        .write_all(password.as_bytes())
        .and_then(|_| std::io::stdout().write_all(b"\n"))
        .and_then(|_| std::io::stdout().flush());
    // Best-effort clearing of the owned String before it is dropped.
    unsafe { password.as_bytes_mut().fill(0) };
    Some(if result.is_ok() { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_password_and_host_prompts_without_confusing_other_challenges() {
        assert!(is_password_prompt("dev@example.com's password:"));
        assert!(is_password_prompt("Password:"));
        assert!(!is_password_prompt("Verification code:"));
        assert!(is_host_confirmation_prompt(
            "Are you sure you want to continue connecting (yes/no/[fingerprint])?"
        ));
        assert!(!is_host_confirmation_prompt("Password:"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_credential_round_trip_never_uses_connection_json() {
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = delete_password(&self.0);
            }
        }

        let id = format!("credential-test-{}", uuid::Uuid::new_v4());
        let _cleanup = Cleanup(id.clone());
        if let Err(error) = save_password(&id, "correct horse battery staple") {
            // Sandboxed/network-logon CI tokens do not have a Windows
            // credential set. A normal interactive desktop logon does.
            if matches!(&error, AppError::Io(io) if io.raw_os_error() == Some(1312)) {
                return;
            }
            panic!("failed to save the test credential: {error}");
        }
        assert!(password_exists(&id).unwrap());
        assert_eq!(
            read_password(&id).unwrap().as_deref(),
            Some("correct horse battery staple")
        );
        delete_password(&id).unwrap();
        assert!(!password_exists(&id).unwrap());
    }
}

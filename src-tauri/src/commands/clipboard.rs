//! Native clipboard commands.
//!
//! Clipboard reads are kept in the native process so a terminal right-click
//! paste does not invoke the WebView Clipboard API's permission prompt.

#[cfg(windows)]
use std::slice;

#[cfg(windows)]
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, OpenClipboard,
};
#[cfg(windows)]
use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
#[cfg(windows)]
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

/// Read Unicode text from the operating-system clipboard without involving
/// WebView's clipboard permission model.
#[tauri::command]
pub fn read_clipboard_text() -> Result<String, String> {
    #[cfg(windows)]
    {
        // Clipboard functions require a single open/close pair on the same
        // thread. The native Tauri command executes that pair synchronously.
        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return Err("Unable to open the clipboard".into());
            }

            let handle = GetClipboardData(CF_UNICODETEXT.into());
            if handle.is_null() {
                CloseClipboard();
                return Ok(String::new());
            }

            let text = GlobalLock(handle) as *const u16;
            if text.is_null() {
                CloseClipboard();
                return Err("Unable to read clipboard text".into());
            }

            let mut len = 0usize;
            while *text.add(len) != 0 {
                len += 1;
            }
            let value = String::from_utf16_lossy(slice::from_raw_parts(text, len));
            GlobalUnlock(handle);
            CloseClipboard();
            Ok(value)
        }
    }

    #[cfg(not(windows))]
    {
        Err("Native clipboard paste is only supported on Windows".into())
    }
}

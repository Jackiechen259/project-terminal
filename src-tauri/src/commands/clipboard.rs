//! Native clipboard commands.
//!
//! Clipboard reads and writes stay in the native process so a terminal
//! right-click copy/paste does not depend on the WebView Clipboard API.
//! `navigator.clipboard.writeText` requires a transient user activation that
//! is already gone by the time `terminal_selection_text` returns, so copy
//! must not go through that path.
//!
//! TUI applications also write the clipboard through OSC 52. That path is
//! model-owned (`wezterm-term::Clipboard`) and reuses the same native write.

use std::sync::Arc;

use wezterm_term::{Clipboard, ClipboardSelection};

#[cfg(windows)]
use std::slice;

#[cfg(windows)]
use windows_sys::Win32::Foundation::GlobalFree;
#[cfg(windows)]
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData,
};
#[cfg(windows)]
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
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

/// OSC 52 payloads larger than this are dropped rather than copied. A TUI
/// that wants to exfiltrate a file through the clipboard should not get a
/// multi-megabyte silent write from this process.
pub const MAX_OSC52_BYTES: usize = 1024 * 1024;

/// Accept a decoded OSC 52 payload, or `None` when it should be ignored.
pub fn osc52_clipboard_text(data: Option<String>) -> Option<String> {
    let text = data?;
    if text.len() > MAX_OSC52_BYTES {
        tracing::warn!(
            bytes = text.len(),
            limit = MAX_OSC52_BYTES,
            "dropping oversized OSC 52 clipboard write"
        );
        return None;
    }
    Some(text)
}

/// Clipboard sink installed on each wezterm-term model so OSC 52 yank from
/// vim/tmux/lazygit reaches the operating-system clipboard.
pub struct Osc52Clipboard;

impl Clipboard for Osc52Clipboard {
    fn set_contents(
        &self,
        _selection: ClipboardSelection,
        data: Option<String>,
    ) -> anyhow::Result<()> {
        let Some(text) = osc52_clipboard_text(data) else {
            return Ok(());
        };
        write_clipboard_text(text).map_err(anyhow::Error::msg)
    }
}

impl Osc52Clipboard {
    pub fn shared() -> Arc<dyn Clipboard> {
        Arc::new(Self)
    }
}

/// Write Unicode text to the operating-system clipboard without involving
/// WebView's clipboard permission model or user-activation token.
#[tauri::command]
pub fn write_clipboard_text(text: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut encoded: Vec<u16> = text.encode_utf16().collect();
        encoded.push(0);
        let bytes = encoded.len().saturating_mul(std::mem::size_of::<u16>());
        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return Err("Unable to open the clipboard".into());
            }
            if EmptyClipboard() == 0 {
                CloseClipboard();
                return Err("Unable to empty the clipboard".into());
            }
            let handle = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if handle.is_null() {
                CloseClipboard();
                return Err("Unable to allocate clipboard memory".into());
            }
            let dest = GlobalLock(handle) as *mut u16;
            if dest.is_null() {
                GlobalFree(handle);
                CloseClipboard();
                return Err("Unable to lock clipboard memory".into());
            }
            std::ptr::copy_nonoverlapping(encoded.as_ptr(), dest, encoded.len());
            GlobalUnlock(handle);
            if SetClipboardData(CF_UNICODETEXT.into(), handle).is_null() {
                GlobalFree(handle);
                CloseClipboard();
                return Err("Unable to set clipboard text".into());
            }
            CloseClipboard();
            Ok(())
        }
    }

    #[cfg(not(windows))]
    {
        let _ = text;
        Err("Native clipboard copy is only supported on Windows".into())
    }
}

#[cfg(test)]
mod osc52_tests {
    use super::*;

    #[test]
    fn osc52_accepts_a_bounded_payload_and_drops_an_oversized_one() {
        assert_eq!(
            osc52_clipboard_text(Some("yank".into())).as_deref(),
            Some("yank")
        );
        assert_eq!(osc52_clipboard_text(None), None);
        let oversized = "x".repeat(MAX_OSC52_BYTES + 1);
        assert_eq!(osc52_clipboard_text(Some(oversized)), None);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static CLIPBOARD: Mutex<()> = Mutex::new(());

    #[test]
    fn write_then_read_roundtrips_unicode_text() {
        let _guard = CLIPBOARD.lock().expect("clipboard lock");
        let sample = "hello 你好 copy";
        write_clipboard_text(sample.to_string()).expect("write clipboard");
        let read = read_clipboard_text().expect("read clipboard");
        assert_eq!(read, sample);
    }
}

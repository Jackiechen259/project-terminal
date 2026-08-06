//! Opening links that came out of a terminal in the user's browser.
//!
//! The URL originates in program output, so it is untrusted input that happens
//! to have been rendered. Two rules follow from that, and both are enforced
//! here rather than in the renderer:
//!
//! 1. Only `http` and `https` are accepted. `file:`, `javascript:` and the
//!    shell handlers registered for arbitrary custom schemes are all reachable
//!    through the same OS call, and none of them should be one click away from
//!    whatever a program decided to print.
//! 2. The URL is handed to a process as a single argument. No shell is
//!    involved, so there is nothing for `&`, `|` or `%VAR%` to expand into.

use crate::error::{AppError, AppResult};

/// Long enough for real links, short enough that a runaway program cannot make
/// us hand a megabyte to the shell handler.
const MAX_URL_LENGTH: usize = 2048;

/// Reject a URL unless it is plainly a web link.
///
/// Deliberately stricter than the URL grammar: anything with whitespace,
/// control characters, quotes or non-ASCII is refused rather than escaped.
/// Percent-encoding is the correct way to express those, and every browser
/// emits links that way.
fn validate_web_url(url: &str) -> AppResult<()> {
    if url.is_empty() || url.len() > MAX_URL_LENGTH {
        return Err(AppError::Configuration("Link is not a valid URL".into()));
    }

    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or_else(|| {
            AppError::Configuration("Only http and https links can be opened".into())
        })?;
    if rest.is_empty() {
        return Err(AppError::Configuration("Link is missing a host".into()));
    }

    // `\` is excluded as well: browsers normalise it to `/`, which makes
    // `https://example.com\@evil.test` read as one host and resolve as another.
    let forbidden = |c: char| {
        c.is_ascii_whitespace()
            || c.is_ascii_control()
            || !c.is_ascii()
            || matches!(c, '"' | '\'' | '`' | '\\' | '<' | '>' | '|' | '^')
    };
    if url.contains(forbidden) {
        return Err(AppError::Configuration(
            "Link contains characters that are not allowed".into(),
        ));
    }

    Ok(())
}

/// Open a validated http(s) URL with the system's default handler.
#[tauri::command]
pub fn open_external_url(url: String) -> AppResult<()> {
    validate_web_url(&url)?;

    #[cfg(windows)]
    {
        // Explorer resolves a web URL to the default browser. Spawning it
        // directly keeps the URL a single argv entry; going through
        // `cmd /c start` would expose it to `%` expansion.
        let mut command = std::process::Command::new("explorer.exe");
        command.arg(&url);
        crate::platform::hide_background_process_window(&mut command);
        command.spawn().map_err(AppError::Io)?;
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(AppError::Io)?;
        Ok(())
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(AppError::Io)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ordinary_web_links() {
        validate_web_url("https://example.com").unwrap();
        validate_web_url("http://example.com/a/b?c=d&e=f#g").unwrap();
        validate_web_url("https://example.com/%E4%B8%AD%E6%96%87").unwrap();
        validate_web_url("HTTPS://Example.COM/Path").unwrap();
    }

    #[test]
    fn rejects_non_web_schemes() {
        for url in [
            "file:///C:/Windows/System32",
            "javascript:alert(1)",
            "ms-settings:privacy",
            "vscode://file/etc/passwd",
            "//example.com",
            "example.com",
        ] {
            assert!(validate_web_url(url).is_err(), "accepted {url}");
        }
    }

    #[test]
    fn rejects_shell_and_spoofing_characters() {
        for url in [
            "https://example.com/a b",
            "https://example.com/\"quoted\"",
            "https://example.com\\@evil.test",
            "https://example.com/a\nb",
            "https://example.com/a|b",
            "https://exämple.com",
        ] {
            assert!(validate_web_url(url).is_err(), "accepted {url}");
        }
    }

    #[test]
    fn rejects_empty_and_oversized_links() {
        assert!(validate_web_url("").is_err());
        assert!(validate_web_url("https://").is_err());
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LENGTH));
        assert!(validate_web_url(&long).is_err());
    }
}

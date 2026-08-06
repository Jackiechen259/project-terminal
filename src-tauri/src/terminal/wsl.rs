//! WSL distribution discovery and the environment bridge into a distribution.
//!
//! `wsl.exe --list --quiet` enumerates installed distributions. On Windows the
//! CLI emits UTF-16LE bytes (with or without a BOM depending on the build);
//! on non-Windows hosts `wsl.exe` is unavailable and detection returns an
//! empty list rather than an error, so the frontend can render an empty
//! dropdown without surfacing a failure to the user.

/// Build the `WSLENV` value that carries `names` into a WSL distribution.
///
/// Setting a variable on the Windows side is not enough: `wsl.exe` forwards
/// only what `WSLENV` names, so a profile's environment variables are
/// otherwise invisible inside the distribution, as is the `TERMINFO` entry
/// that teaches a session's `TERM` to ncurses.
///
/// Entries may carry a translation flag after a slash - `/p` converts a single
/// Windows path to a Linux one, `/l` a path list, `/u` and `/w` restrict the
/// direction. A bare name is passed through byte for byte, which is what
/// everything here wants: a `TERMINFO` value is a compiled terminfo entry, not
/// a path, and translating it would corrupt it.
///
/// `inherited` is preserved as-is, flags included: the user, or a tool that
/// launched this app, may already depend on those entries.
pub fn merge_wslenv<'a>(
    inherited: Option<&str>,
    names: impl IntoIterator<Item = &'a str>,
) -> Option<String> {
    let mut entries: Vec<String> = Vec::new();
    // Windows environment variable names are case-insensitive, so compare
    // that way; the entry keeps whatever case it was written with.
    let mut seen: Vec<String> = Vec::new();
    let push = |entry: &str, seen: &mut Vec<String>, entries: &mut Vec<String>| {
        let entry = entry.trim();
        if entry.is_empty() {
            return;
        }
        let name = entry.split('/').next().unwrap_or(entry);
        if name.is_empty() {
            return;
        }
        let key = name.to_ascii_uppercase();
        if seen.contains(&key) {
            return;
        }
        seen.push(key);
        entries.push(entry.to_string());
    };

    for entry in inherited.unwrap_or_default().split(':') {
        push(entry, &mut seen, &mut entries);
    }
    for name in names {
        push(name, &mut seen, &mut entries);
    }

    (!entries.is_empty()).then(|| entries.join(":"))
}

/// A detected WSL distribution. Only the name is exposed today; the field is
/// kept as a struct so future metadata (default flag, version) can be added
/// without breaking the IPC contract.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedWslDistribution {
    pub name: String,
}

#[cfg(test)]
mod wslenv_tests {
    use super::merge_wslenv;

    #[test]
    fn names_are_joined_and_deduplicated() {
        assert_eq!(
            merge_wslenv(None, ["TERM", "TERMINFO", "TERM"]),
            Some("TERM:TERMINFO".to_string())
        );
    }

    #[test]
    fn inherited_entries_are_preserved_with_their_flags() {
        // A tool that launched this app may already depend on these, including
        // the path-translation flag.
        assert_eq!(
            merge_wslenv(Some("MY_PATH/p:OTHER"), ["TERM"]),
            Some("MY_PATH/p:OTHER:TERM".to_string())
        );
    }

    #[test]
    fn an_inherited_entry_is_not_duplicated_or_stripped_of_its_flag() {
        // Windows env names are case-insensitive, so `term` and `TERM` are the
        // same variable, and the inherited spelling wins.
        assert_eq!(
            merge_wslenv(Some("term/p"), ["TERM", "TERMINFO"]),
            Some("term/p:TERMINFO".to_string())
        );
    }

    #[test]
    fn empty_input_produces_no_variable() {
        assert_eq!(merge_wslenv(None, []), None);
        assert_eq!(merge_wslenv(Some(""), []), None);
        assert_eq!(merge_wslenv(Some("::"), []), None);
    }
}

/// Run `wsl.exe --list --quiet` and return the parsed distribution names.
///
/// Returns an empty vec when `wsl.exe` is missing or the command fails - the
/// frontend treats this as "no distributions available" rather than an error.
pub fn detect_wsl_distributions() -> Vec<DetectedWslDistribution> {
    let output = match std::process::Command::new("wsl.exe")
        .args(["--list", "--quiet"])
        .output()
    {
        Ok(output) => output,
        Err(_) => return Vec::new(),
    };

    if !output.status.success() {
        return Vec::new();
    }

    parse_wsl_distribution_list(&output.stdout)
}

/// Pure parser for the bytes returned by `wsl.exe --list --quiet`.
///
/// Handles UTF-16LE (with or without BOM) and falls back to UTF-8 for the
/// rare case where the CLI emits ANSI output. Filters the legacy header line
/// that some Windows builds print even with `--quiet`.
pub fn parse_wsl_distribution_list(bytes: &[u8]) -> Vec<DetectedWslDistribution> {
    let text = decode_wsl_output(bytes);
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !is_header_line(line))
        .map(|line| DetectedWslDistribution {
            name: line.trim_matches('\u{feff}').trim().to_string(),
        })
        .collect()
}

fn is_header_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.starts_with("windows subsystem for linux")
        || lower.contains("distributions:")
        // `wsl --list -v` prints a column header; harmless if --quiet ever
        // leaks it through.
        || lower == "name state version"
}

fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_utf16le(&bytes[2..]);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let swapped: Vec<u8> = bytes
            .chunks_exact(2)
            .skip(1)
            .flat_map(|chunk| [chunk[1], chunk[0]])
            .collect();
        return decode_utf16le(&swapped);
    }
    if looks_like_utf16le(bytes) {
        return decode_utf16le(bytes);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// Heuristic: detect UTF-16LE ASCII output by checking that the high byte of
/// the first several code units is zero. `wsl.exe` typically prints distro
/// names using the ASCII subset, so this catches the common case where no BOM
/// is emitted.
fn looks_like_utf16le(bytes: &[u8]) -> bool {
    bytes.len() >= 2
        && bytes
            .chunks_exact(2)
            .take(8)
            .all(|chunk| chunk.len() == 2 && chunk[1] == 0)
}

fn decode_utf16le(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16le(s: &str) -> Vec<u8> {
        let mut out = Vec::new();
        for unit in s.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        out
    }

    #[test]
    fn parses_utf16le_without_bom() {
        let bytes = utf16le("Ubuntu\r\nDebian\r\n");
        let distros = parse_wsl_distribution_list(&bytes);
        assert_eq!(
            distros.iter().map(|d| d.name.clone()).collect::<Vec<_>>(),
            vec!["Ubuntu".to_string(), "Debian".to_string()]
        );
    }

    #[test]
    fn parses_utf16le_with_bom() {
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(utf16le("Ubuntu\r\n"));
        let distros = parse_wsl_distribution_list(&bytes);
        assert_eq!(distros.len(), 1);
        assert_eq!(distros[0].name, "Ubuntu");
    }

    #[test]
    fn parses_utf16be_with_bom() {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in "Ubuntu\r\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        let distros = parse_wsl_distribution_list(&bytes);
        assert_eq!(distros.len(), 1);
        assert_eq!(distros[0].name, "Ubuntu");
    }

    #[test]
    fn falls_back_to_utf8_for_ascii_output() {
        let bytes = b"Ubuntu\nDebian\n";
        let distros = parse_wsl_distribution_list(bytes);
        assert_eq!(distros.len(), 2);
        assert_eq!(distros[0].name, "Ubuntu");
        assert_eq!(distros[1].name, "Debian");
    }

    #[test]
    fn empty_input_returns_empty_list() {
        assert!(parse_wsl_distribution_list(b"").is_empty());
        assert!(parse_wsl_distribution_list(&[]).is_empty());
    }

    #[test]
    fn whitespace_only_lines_are_skipped() {
        let bytes = utf16_le_bytes_with_bom("\r\n  \r\nUbuntu\r\n");
        let distros = parse_wsl_distribution_list(&bytes);
        assert_eq!(distros.len(), 1);
        assert_eq!(distros[0].name, "Ubuntu");
    }

    fn utf16_le_bytes_with_bom(s: &str) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(utf16le(s));
        bytes
    }

    #[test]
    fn header_line_is_filtered_when_present() {
        let bytes = utf16le("Windows Subsystem for Linux Distributions:\r\nUbuntu\r\n");
        let distros = parse_wsl_distribution_list(&bytes);
        assert_eq!(distros.len(), 1);
        assert_eq!(distros[0].name, "Ubuntu");
    }

    #[test]
    fn detects_single_distribution_utf16le() {
        // Mimic the real `wsl.exe --list --quiet` output for one distro.
        let bytes = utf16le("Ubuntu\r\n");
        assert!(looks_like_utf16le(&bytes));
        let distros = parse_wsl_distribution_list(&bytes);
        assert_eq!(distros.len(), 1);
    }

    #[test]
    fn detects_default_marker_in_distribution_name() {
        // `wsl --list` marks the default distro with a trailing asterisk when
        // not in --quiet mode, but --quiet omits it. We still preserve the
        // raw name so any future suffix the CLI prints is not silently stripped.
        let bytes = utf16le("Ubuntu\r\n");
        let distros = parse_wsl_distribution_list(&bytes);
        assert_eq!(distros[0].name, "Ubuntu");
    }
}

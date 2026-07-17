//! Per-shell command-line escaping. The plan (§24) requires separate
//! implementations per shell rather than one generic function, because
//! PowerShell, CMD, and POSIX shells have different quoting rules and
//! different dangerous metacharacters.
//!
//! These helpers are only used when the backend must write a command into an
//! interactive shell (e.g. `cd -- 'path'` for SSH remote cwd, or a Conda
//! activation command). When argv-style argument arrays are possible we
//! prefer them and never go through these helpers.

/// Escape a single argument for a PowerShell command line.
///
/// PowerShell uses backtick as its escape character inside double quotes.
/// Outside quotes we wrap the value in single quotes and double any
/// embedded single quotes. Single-quoted strings are literal in PowerShell.
pub fn escape_powershell_argument(input: &str) -> String {
    if input.is_empty() {
        return "''".to_string();
    }
    // If the value is "safe" (alphanumeric plus a small allowlist) we leave
    // it unquoted for readability.
    if input
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | '\\' | ':'))
    {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len() + 2);
    out.push('\'');
    for c in input.chars() {
        if c == '\'' {
            out.push('\'');
            out.push('\'');
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Escape a single argument for the Windows CMD shell.
///
/// CMD has no single-quote form; we use double quotes and escape embedded
/// double quotes with `^"` (caret-quote). Carets themselves are escaped.
pub fn escape_cmd_argument(input: &str) -> String {
    if input.is_empty() {
        return "\"\"".to_string();
    }
    if input
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len() + 2);
    out.push('"');
    for c in input.chars() {
        match c {
            '"' => out.push_str("^\""),
            '%' => out.push_str("^%"),
            '^' => out.push_str("^^"),
            '&' => out.push_str("^&"),
            '|' => out.push_str("^|"),
            '<' => out.push_str("^<"),
            '>' => out.push_str("^>"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Escape a single argument for a local bash/sh invocation.
///
/// POSIX single-quoted strings are literal; embedded single quotes are
/// closed, escaped, and reopened.
pub fn escape_bash_argument(input: &str) -> String {
    if input.is_empty() {
        return "''".to_string();
    }
    if input
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':' | '='))
    {
        return input.to_string();
    }
    let mut out = String::with_capacity(input.len() + 2);
    out.push('\'');
    for c in input.chars() {
        if c == '\'' {
            out.push_str("'\"'\"'");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Escape an argument destined for a *remote* POSIX shell. Identical rules
/// to `escape_bash_argument` but kept separate per the plan so that future
/// remote-shell-specific handling (e.g. NUL-byte rejection) does not bleed
/// into the local path.
pub fn escape_remote_posix_argument(input: &str) -> String {
    escape_bash_argument(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn powershell_safe_value_is_unquoted() {
        assert_eq!(escape_powershell_argument("D:\\Demo"), "D:\\Demo");
        assert_eq!(escape_powershell_argument("simple"), "simple");
    }

    #[test]
    fn powershell_quoted_value_doubles_single_quotes() {
        let s = escape_powershell_argument("it's a test");
        assert_eq!(s, "'it''s a test'");
    }

    #[test]
    fn powershell_empty_becomes_two_single_quotes() {
        assert_eq!(escape_powershell_argument(""), "''");
    }

    #[test]
    fn powershell_unicode_is_quoted() {
        let s = escape_powershell_argument("D:\\开发\\测试 项目");
        assert!(s.starts_with('\''));
        assert!(s.ends_with('\''));
        assert!(s.contains("开发"));
    }

    #[test]
    fn cmd_safe_value_is_unquoted() {
        assert_eq!(escape_cmd_argument("simple"), "simple");
    }

    #[test]
    fn cmd_quoted_value_escapes_double_quote_and_meta() {
        assert_eq!(escape_cmd_argument("a\"b"), "\"a^\"b\"");
        assert_eq!(escape_cmd_argument("a&b"), "\"a^&b\"");
        assert_eq!(escape_cmd_argument("a|b"), "\"a^|b\"");
        assert_eq!(escape_cmd_argument("a<b"), "\"a^<b\"");
    }

    #[test]
    fn cmd_empty_becomes_two_double_quotes() {
        assert_eq!(escape_cmd_argument(""), "\"\"");
    }

    #[test]
    fn bash_safe_value_is_unquoted() {
        assert_eq!(escape_bash_argument("/usr/local/bin"), "/usr/local/bin");
        assert_eq!(escape_bash_argument("PYTHONUTF8=1"), "PYTHONUTF8=1");
    }

    #[test]
    fn bash_quoted_value_escapes_single_quote() {
        let s = escape_bash_argument("it's a test");
        assert_eq!(s, "'it'\"'\"'s a test'");
    }

    #[test]
    fn bash_handles_spaces_and_unicode() {
        let s = escape_bash_argument("/home/user/项目/测试 项目");
        assert!(s.starts_with('\''));
        assert!(s.ends_with('\''));
        assert!(s.contains("项目"));
    }

    #[test]
    fn bash_empty_becomes_two_single_quotes() {
        assert_eq!(escape_bash_argument(""), "''");
    }

    #[test]
    fn remote_posix_matches_bash_for_simple_input() {
        assert_eq!(
            escape_remote_posix_argument("/home/user/proj"),
            escape_bash_argument("/home/user/proj")
        );
    }

    #[test]
    fn remote_posix_quoted_with_spaces() {
        let s = escape_remote_posix_argument("/home/user/my project");
        assert_eq!(s, "'/home/user/my project'");
    }
}

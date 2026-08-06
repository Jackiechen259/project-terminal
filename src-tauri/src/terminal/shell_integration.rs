//! Scripts that teach a shell to report where it is and what it is doing.
//!
//! Two sequences, both standard: OSC 7 carries the working directory, OSC 133
//! marks where a prompt begins, where a command begins, and how it ended.
//!
//! # The rule these scripts live by
//!
//! **Append, never replace.** Users run starship, oh-my-posh, powerlevel10k,
//! oh-my-zsh - prompts that took effort to set up and that they will not
//! forgive us for breaking. Every script here captures what is already there
//! and wraps it, or registers alongside it. None assigns over a prompt.
//!
//! # Delivery
//!
//! These are written to a temporary file and sourced, never typed into the
//! PTY line by line. A multi-line definition typed at an interactive prompt
//! makes PSReadLine repaint wrapped fragments into the terminal, which is the
//! same reason the readiness handshake is kept to one short line.
//!
//! They also run *after* the user's own profile, because they are injected
//! into an already-interactive shell. That ordering is what makes wrapping
//! work: we wrap starship, rather than starship wrapping us.

use crate::profile::ShellType;

/// Environment variable naming the script to source.
pub const SCRIPT_PATH_ENV: &str = "PROJECT_TERMINAL_SHELL_INTEGRATION";

/// PowerShell: wrap `prompt`, and wrap the ReadLine host for the command mark.
///
/// `$function:prompt` is captured by value first, so the wrapper calls the
/// previous implementation rather than recursing. `$LASTEXITCODE` is read
/// before anything else runs, because calling the original prompt clobbers it.
const POWERSHELL: &str = r#"
if (-not $global:__ptShellIntegration) {
  $global:__ptShellIntegration = $true
  $global:__ptOriginalPrompt = $function:prompt
  function global:prompt {
    $exitCode = if ($global:__ptLastExit -ne $null) { $global:__ptLastExit } else { 0 }
    $esc = [char]27
    $bel = [char]7
    $rendered = & $global:__ptOriginalPrompt
    $cwd = $ExecutionContext.SessionState.Path.CurrentLocation
    $marks = "$esc]133;D;$exitCode$bel$esc]133;A$bel"
    if ($cwd.Provider.Name -eq 'FileSystem') {
      $path = $cwd.ProviderPath -replace '\\', '/'
      $marks += "$esc]7;file:///$path$bel"
    }
    "$marks$rendered$esc]133;B$bel"
  }
  if (Test-Path function:\PSConsoleHostReadLine) {
    $global:__ptOriginalReadLine = $function:PSConsoleHostReadLine
    function global:PSConsoleHostReadLine {
      $line = & $global:__ptOriginalReadLine
      Write-Host -NoNewline "$([char]27)]133;C$([char]7)"
      $line
    }
  }
  $global:__ptLastExit = 0
  $ExecutionContext.SessionState.InvokeCommand.PostCommandLookupAction = {
    $global:__ptLastExit = $LASTEXITCODE
  }
}
"#;

/// bash: append to `PROMPT_COMMAND` and bracket the marks inside `PS1`.
///
/// The `\[` `\]` around the escape sequences are not decoration. They tell
/// readline the bytes between them occupy no columns; without them every
/// prompt with colour in it - which is all of them - miscounts its own width
/// and starts overwriting itself as soon as a line wraps.
///
/// `bash-preexec` is detected rather than fought: direnv and others install a
/// `DEBUG` trap through it, and adding a second one silently replaces theirs.
const BASH: &str = r#"
if [ -z "${__PT_SHELL_INTEGRATION:-}" ]; then
  __PT_SHELL_INTEGRATION=1
  __pt_prompt_command() {
    local exit_code=$?
    printf '\033]133;D;%s\007\033]7;file://%s%s\007' "$exit_code" "${HOSTNAME:-}" "$PWD"
  }
  if [ -n "${preexec_functions+x}" ]; then
    # bash-preexec is installed; register through it so its DEBUG trap stays.
    precmd_functions+=(__pt_prompt_command)
    __pt_preexec() { printf '\033]133;C\007'; }
    preexec_functions+=(__pt_preexec)
  else
    PROMPT_COMMAND="__pt_prompt_command${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
    trap 'printf "\033]133;C\007"' DEBUG
  fi
  PS1='\[\033]133;A\007\]'"$PS1"'\[\033]133;B\007\]'
fi
"#;

/// zsh: register hook functions. `$PROMPT` is never touched.
const ZSH: &str = r#"
if [[ -z "${__PT_SHELL_INTEGRATION:-}" ]]; then
  __PT_SHELL_INTEGRATION=1
  __pt_precmd() {
    local exit_code=$?
    print -n "\033]133;D;${exit_code}\007\033]7;file://${HOST}${PWD}\007\033]133;A\007"
  }
  __pt_preexec() { print -n "\033]133;C\007" }
  autoload -Uz add-zsh-hook 2>/dev/null && {
    add-zsh-hook precmd __pt_precmd
    add-zsh-hook preexec __pt_preexec
  }
fi
"#;

/// fish: copy `fish_prompt` aside and redefine it around the copy.
///
/// fish 3 already emits OSC 7 itself. Emitting it again is harmless - the last
/// value wins, and both are the same directory - so it is left in rather than
/// version-sniffed.
const FISH: &str = r#"
if not set -q __PT_SHELL_INTEGRATION
  set -g __PT_SHELL_INTEGRATION 1
  functions --copy fish_prompt __pt_original_fish_prompt
  function fish_prompt
    set -l exit_code $status
    printf '\033]133;D;%s\007\033]7;file://%s%s\007\033]133;A\007' $exit_code (hostname) "$PWD"
    __pt_original_fish_prompt
    printf '\033]133;B\007'
  end
  function __pt_preexec --on-event fish_preexec
    printf '\033]133;C\007'
  end
end
"#;

/// The integration script for `shell_type`, if one exists.
///
/// CMD has no prompt hook of any kind, so it is not supported rather than
/// approximated.
pub fn integration_script(shell_type: ShellType) -> Option<&'static str> {
    match shell_type {
        ShellType::Powershell => Some(POWERSHELL),
        ShellType::GitBash | ShellType::Bash | ShellType::Sh | ShellType::Wsl => Some(BASH),
        ShellType::Zsh => Some(ZSH),
        ShellType::Fish => Some(FISH),
        _ => None,
    }
}

/// The one-line command that sources the script named by [`SCRIPT_PATH_ENV`].
///
/// Short on purpose: it is typed into the PTY, and PSReadLine repaints wrapped
/// fragments into the terminal.
pub fn source_command(shell_type: ShellType) -> Option<&'static str> {
    match shell_type {
        ShellType::Powershell => Some(". $env:PROJECT_TERMINAL_SHELL_INTEGRATION"),
        ShellType::GitBash | ShellType::Bash | ShellType::Sh | ShellType::Wsl => {
            Some(". \"$PROJECT_TERMINAL_SHELL_INTEGRATION\"")
        }
        ShellType::Zsh => Some("source \"$PROJECT_TERMINAL_SHELL_INTEGRATION\""),
        ShellType::Fish => Some("source \"$PROJECT_TERMINAL_SHELL_INTEGRATION\""),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_shell_has_both_halves() {
        for shell in [
            ShellType::Powershell,
            ShellType::Bash,
            ShellType::GitBash,
            ShellType::Zsh,
            ShellType::Fish,
            ShellType::Sh,
        ] {
            assert!(integration_script(shell).is_some(), "{shell:?} script");
            assert!(source_command(shell).is_some(), "{shell:?} source command");
        }
        // CMD has no prompt hook. Not supported beats approximated.
        assert!(integration_script(ShellType::Cmd).is_none());
        assert!(source_command(ShellType::Cmd).is_none());
    }

    #[test]
    fn no_script_assigns_over_a_users_prompt() {
        // The rule these scripts live by. Users run starship, oh-my-posh and
        // powerlevel10k, and will not forgive a terminal that overwrites them.
        assert!(POWERSHELL.contains("$global:__ptOriginalPrompt = $function:prompt"));
        assert!(POWERSHELL.contains("& $global:__ptOriginalPrompt"));
        // bash is the one that must edit PS1, so it appends around it.
        assert!(BASH.contains(r#"PS1='\[\033]133;A\007\]'"$PS1"'\[\033]133;B\007\]'"#));
        assert!(BASH.contains("${PROMPT_COMMAND:+;$PROMPT_COMMAND}"));
        // zsh and fish never need to.
        assert!(!ZSH.contains("PROMPT="));
        assert!(FISH.contains("functions --copy fish_prompt"));
    }

    #[test]
    fn bash_marks_are_bracketed_as_zero_width() {
        // Without `\[` `\]`, readline counts the escape bytes as columns and
        // every prompt with colour in it overwrites itself once a line wraps.
        for mark in [r"\[\033]133;A\007\]", r"\[\033]133;B\007\]"] {
            assert!(BASH.contains(mark), "{mark} should be bracketed");
        }
    }

    #[test]
    fn bash_registers_through_bash_preexec_when_it_is_present() {
        // direnv and others install their DEBUG trap through bash-preexec.
        // Installing a second one silently replaces theirs.
        assert!(BASH.contains("preexec_functions+=(__pt_preexec)"));
        assert!(BASH.contains(r#"if [ -n "${preexec_functions+x}" ]"#));
    }

    #[test]
    fn every_script_is_idempotent() {
        // Sourced twice - a nested shell, a re-run profile - the wrappers
        // would otherwise wrap each other and the prompt would gain a copy of
        // its marks per level.
        assert!(POWERSHELL.contains("if (-not $global:__ptShellIntegration)"));
        assert!(BASH.contains(r#"if [ -z "${__PT_SHELL_INTEGRATION:-}" ]"#));
        assert!(ZSH.contains(r#"if [[ -z "${__PT_SHELL_INTEGRATION:-}" ]]"#));
        assert!(FISH.contains("if not set -q __PT_SHELL_INTEGRATION"));
    }

    #[test]
    fn the_source_command_stays_short_enough_not_to_wrap() {
        // It is typed at an interactive prompt; a long line makes PSReadLine
        // repaint wrapped fragments into the terminal.
        for shell in [ShellType::Powershell, ShellType::Bash, ShellType::Zsh] {
            let command = source_command(shell).unwrap();
            assert!(command.len() < 70, "{shell:?}: {command}");
            assert!(!command.contains('\n'));
        }
    }
}

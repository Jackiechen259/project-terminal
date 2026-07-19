/**
 * OSC window-title sequences are emitted by shells and interactive agents.
 * Keep the tab strip readable and avoid accepting terminal control characters
 * as visible UI text.
 */
function normaliseTerminalTitle(value: string): string | null {
  const title = value.replace(/\p{Cc}/gu, "").trim();
  return title ? title.slice(0, 160) : null;
}

/**
 * PowerShell may set the terminal title to its executable path after a child
 * process (such as an agent) exits. That path is useful neither as a tab name
 * nor as the shell label, so restore the profile's stable title instead.
 */
export function resolveTerminalTabTitle(
  value: string,
  defaultTitle: string,
): string | null {
  const title = normaliseTerminalTitle(value);
  if (!title) return null;

  return /^[a-z]:[\\/]/i.test(title) || title.startsWith("\\\\")
    ? defaultTitle
    : title;
}

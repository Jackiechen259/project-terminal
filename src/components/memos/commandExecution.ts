/**
 * Command memo execution.
 *
 * A memo command must run inside the project's EXISTING PTY session - the
 * same one the user is typing in - so Local / WSL / SSH all resolve through
 * the session's own environment. Nothing here spawns a shell; these helpers
 * only forward keystrokes into the live terminal, exactly like the user
 * typing. Enter is `\r`, the conventional terminal carriage-return key.
 */

import { terminalService } from "@/services";

/** Write the command without Enter: the user reviews and edits it first. */
export async function insertCommand(
  sessionId: string,
  command: string,
): Promise<void> {
  await terminalService.write(sessionId, command);
}

/** Write the command and press Enter, exactly like typing it. */
export async function runCommand(
  sessionId: string,
  command: string,
): Promise<void> {
  await terminalService.write(sessionId, `${command}\r`);
}

/**
 * Copy helper for memo commands. Uses the async Clipboard API where the
 * WebView offers it, with a hidden-textarea fallback for older engines and
 * test environments. Never throws; callers show the result themselves.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

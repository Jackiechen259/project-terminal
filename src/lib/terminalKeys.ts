/**
 * Key chords xterm.js cannot express, encoded by hand.
 *
 * xterm 6 implements neither `modifyOtherKeys` nor the kitty keyboard
 * protocol, and its Enter handling consults only `altKey` - so `Shift+Enter`
 * is indistinguishable from `Enter`, and `Ctrl+Enter` from `Ctrl+M`. Modern
 * agent CLIs bind exactly those two for "newline in the prompt" and "submit",
 * which is why they are the ones worth shimming.
 *
 * The encodings match what terminals with `modifyOtherKeys` send, so a program
 * that already handles those keys elsewhere needs no special case here.
 */

/** `CSI 13 ; <modifier> u` - the CSI-u form for Enter with modifiers. */
function csiU(codepoint: number, modifier: number) {
  return `\x1b[${codepoint};${modifier}u`;
}

/** Enter's codepoint in CSI u is its ASCII value, not its control code. */
const ENTER = 13;

/**
 * The bytes to send for `event`, or null to let xterm handle it.
 *
 * Deliberately narrow: every chord claimed here is one the program can no
 * longer receive as its unmodified form, so the list stays to keys xterm
 * currently collapses.
 */
export function resolveExtraKeySequence(event: KeyboardEvent): string | null {
  if (event.key !== "Enter") return null;
  // Alt+Enter already has a meaning xterm implements (ESC prefix).
  if (event.altKey) return null;

  if (event.shiftKey && !event.ctrlKey) {
    // Shift+Enter: modifier 2. Without this it reaches the program as a bare
    // carriage return, and a prompt that wanted a newline submits instead.
    return csiU(ENTER, 2);
  }
  if (event.ctrlKey && !event.shiftKey) {
    // Ctrl+Enter: modifier 5. Otherwise identical to Ctrl+M.
    return csiU(ENTER, 5);
  }
  if (event.ctrlKey && event.shiftKey) {
    return csiU(ENTER, 6);
  }
  return null;
}

/**
 * Parsing for the shell-integration escape sequences.
 *
 * Everything here reads values that came out of the PTY, which means they came
 * from whatever the user ran. A working directory is not a fact the terminal
 * establishes - it is a claim a program made - so it is parsed defensively,
 * used for display, and re-validated by the backend before anything acts on
 * it.
 */

/** OSC 133 command markers, as emitted by the injected prompt hooks. */
export type PromptMark =
  /** `A` - the prompt is about to be drawn. */
  | { kind: "prompt-start" }
  /** `B` - the prompt is drawn; what follows is what the user typed. */
  | { kind: "command-start" }
  /** `C` - the command is running; what follows is its output. */
  | { kind: "output-start" }
  /** `D` - the command finished, with this status if it reported one. */
  | { kind: "command-finished"; exitCode: number | null };

/**
 * Parse an OSC 133 payload.
 *
 * The payload is everything after `133;`, so `A`, `B`, `C`, `D`, `D;0`, and
 * the `A;key=value` form some shells add. Unknown letters return null rather
 * than throwing: the sequence set grows, and an unrecognised mark is not an
 * error, just something this terminal does not act on.
 */
export function parsePromptMark(payload: string): PromptMark | null {
  const [letter, ...rest] = payload.split(";");
  switch (letter) {
    case "A":
      return { kind: "prompt-start" };
    case "B":
      return { kind: "command-start" };
    case "C":
      return { kind: "output-start" };
    case "D": {
      const raw = rest[0];
      if (raw === undefined || raw === "") {
        return { kind: "command-finished", exitCode: null };
      }
      const exitCode = Number.parseInt(raw, 10);
      return {
        kind: "command-finished",
        exitCode: Number.isFinite(exitCode) ? exitCode : null,
      };
    }
    default:
      return null;
  }
}

/** Hosts an OSC 7 URL may name. Anything else is another machine's path. */
const LOCAL_HOSTS = new Set([
  "",
  "localhost",
  "127.0.0.1",
  "wsl$",
  "wsl.localhost",
]);

/**
 * Parse an OSC 7 working-directory report.
 *
 * The payload is a `file://host/path` URL. Returns null for anything that is
 * not one, names a host this terminal is not attached to, or decodes to
 * something with a control character in it.
 *
 * A Windows path arrives as `/C:/Users/...` - a leading slash the URL grammar
 * requires and the filesystem does not. Converting it here rather than at the
 * consumer keeps every caller from having to know that.
 */
export function parseWorkingDirectory(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed.toLowerCase().startsWith("file://")) return null;

  const afterScheme = trimmed.slice("file://".length);
  const slash = afterScheme.indexOf("/");
  if (slash < 0) return null;
  const host = afterScheme.slice(0, slash).toLowerCase();
  if (!LOCAL_HOSTS.has(host)) return null;

  let path: string;
  try {
    path = decodeURIComponent(afterScheme.slice(slash));
  } catch {
    // Malformed percent-encoding. A program printed something that is not a
    // URL; there is nothing to recover.
    return null;
  }

  // A NUL or a newline in a path means the value was assembled from something
  // other than a real directory. Checked by code point rather than by regex,
  // which would need control-character literals in the pattern.
  if (path.length > 4096) return null;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return null;
  }

  // `/C:/Users/x` is a Windows path wearing the URL's mandatory leading slash.
  const windows = /^\/[a-zA-Z]:[\\/]/.exec(path);
  if (windows) return path.slice(1).replace(/\//g, "\\");
  return path;
}

/**
 * The last path segment, for a tab label.
 *
 * Falls back to the whole path for a root, which is the only case where the
 * last segment is empty and the path still means something.
 */
export function workingDirectoryLabel(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

import type { IWindowsPty } from "@xterm/xterm";

import type { PlatformInfo } from "@/types";

/**
 * ConPTY started marking wrapped lines in this build. Before it, a line that
 * wrapped is indistinguishable from two separate lines, so reflowing scrollback
 * on resize would join text that was never one line.
 */
export const CONPTY_REFLOW_BUILD = 21376;

/**
 * Describe the backing pty to xterm, so it models resizes the way ConPTY
 * actually behaves.
 *
 * ConPTY redraws its own view of the viewport whenever the window grows. xterm
 * assumes a unix pty, which does not, and so also pulls rows down out of
 * scrollback to fill the new space - every line ends up on screen twice. Naming
 * the backend is what suppresses that; the build number additionally tells
 * xterm whether reflow is sound on this host.
 *
 * Returns `undefined` off Windows, where xterm's default model is correct.
 */
export function resolveWindowsPty(
  platform: PlatformInfo | null,
): IWindowsPty | undefined {
  if (platform?.os !== "windows") return undefined;
  // portable-pty resolves to ConPTY on every supported Windows version.
  const backend = "conpty" as const;
  const build = platform.windowsBuild;
  if (typeof build !== "number" || !Number.isFinite(build)) {
    // Naming the backend alone still fixes the duplicated-rows case. Omitting
    // the build leaves reflow at xterm's default rather than guessing an era.
    return { backend };
  }
  return { backend, buildNumber: build };
}

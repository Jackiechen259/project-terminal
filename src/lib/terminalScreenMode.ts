const alternateScreenSessions = new Set<string>();

/** Record whether a live session is currently on the alternate screen. */
export function setTerminalAlternateScreen(sessionId: string, active: boolean) {
  if (active) alternateScreenSessions.add(sessionId);
  else alternateScreenSessions.delete(sessionId);
}

export function isTerminalAlternateScreen(
  sessionId: string | null | undefined,
): boolean {
  return Boolean(sessionId && alternateScreenSessions.has(sessionId));
}

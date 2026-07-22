export type AppCommand =
  | { type: "new-terminal"; projectId: string }
  | { type: "copy-terminal" }
  | { type: "open-settings"; section?: "general" | "profiles" };

const APP_COMMAND_EVENT = "project-terminal:command";

/** Send a command between independent application surfaces. */
export function dispatchAppCommand(command: AppCommand) {
  window.dispatchEvent(
    new CustomEvent<AppCommand>(APP_COMMAND_EVENT, { detail: command }),
  );
}

export function listenForAppCommands(listener: (command: AppCommand) => void) {
  const handleCommand = (event: Event) => {
    listener((event as CustomEvent<AppCommand>).detail);
  };
  window.addEventListener(APP_COMMAND_EVENT, handleCommand);
  return () => window.removeEventListener(APP_COMMAND_EVENT, handleCommand);
}

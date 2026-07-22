import type { TerminalProfile } from "@/types";

export interface BuiltInProfilePreset {
  id: string;
  name: string;
  startupCommands: string[];
}

/** Templates that are always offered as built-in quick-launch choices. */
export const BUILT_IN_PROFILE_PRESETS: BuiltInProfilePreset[] = [
  {
    id: "codex-cli",
    name: "Codex CLI",
    startupCommands: ["codex"],
  },
  {
    id: "oh-my-pi",
    name: "Oh My Pi",
    startupCommands: ["omp"],
  },
];

/** A built-in preset is materialized when a same-name saved item exists. */
export function hasMaterializedPreset(
  items: Pick<TerminalProfile, "name">[],
  preset: BuiltInProfilePreset,
) {
  return Boolean(findProfileByName(items, preset.name));
}

export function normalizedProfileName(name: string) {
  return name.trim().toLowerCase();
}

export function findProfileByName<T extends Pick<TerminalProfile, "name">>(
  profiles: T[],
  name: string,
) {
  const normalizedName = normalizedProfileName(name);
  return profiles.find(
    (profile) => normalizedProfileName(profile.name) === normalizedName,
  );
}

export function uniqueProfilesByName<T extends Pick<TerminalProfile, "name">>(
  profiles: T[],
) {
  const seen = new Set<string>();
  return profiles.filter((profile) => {
    const name = normalizedProfileName(profile.name);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** Missing values from older backends keep the historical visible behavior. */
export function isProfileShownInContextMenu(profile: {
  showInContextMenu?: boolean;
}) {
  return profile.showInContextMenu !== false;
}

/**
 * One-line descriptions of how a profile-shaped configuration launches.
 * Shared by the pickers in settings so a template and an imported Windows
 * Terminal entry read the same way.
 */

export interface LaunchConfigurationLike {
  shellType: string;
  shellExecutable?: string;
  shellArgs?: string[];
  wslDistribution?: string;
  wslWorkingDirectory?: string;
}

export function launchSummary(config: LaunchConfigurationLike): string {
  if (config.wslDistribution) {
    return config.wslWorkingDirectory
      ? `wsl · ${config.wslDistribution} · ${config.wslWorkingDirectory}`
      : `wsl · ${config.wslDistribution}`;
  }
  const command = [config.shellExecutable, ...(config.shellArgs ?? [])]
    .filter(Boolean)
    .join(" ");
  return command || config.shellType;
}

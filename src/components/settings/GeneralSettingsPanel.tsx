import { RefreshCw, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { requestUpdateCheck } from "@/services/updater";
import {
  DEFAULT_GENERAL_SETTINGS,
  useSettingsStore,
} from "@/stores/settingsStore";

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24];

export function GeneralSettingsPanel() {
  const restoreLastProject = useSettingsStore(
    (state) => state.restoreLastProject,
  );
  const confirmCloseTerminal = useSettingsStore(
    (state) => state.confirmCloseTerminal,
  );
  const showTerminalCount = useSettingsStore(
    (state) => state.showTerminalCount,
  );
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const cursorBlink = useSettingsStore((state) => state.cursorBlink);
  const autoCheckForUpdates = useSettingsStore(
    (state) => state.autoCheckForUpdates,
  );
  const update = useSettingsStore((state) => state.updateGeneralSettings);
  const reset = useSettingsStore((state) => state.resetGeneralSettings);

  const isDefault =
    restoreLastProject === DEFAULT_GENERAL_SETTINGS.restoreLastProject &&
    confirmCloseTerminal === DEFAULT_GENERAL_SETTINGS.confirmCloseTerminal &&
    showTerminalCount === DEFAULT_GENERAL_SETTINGS.showTerminalCount &&
    terminalFontSize === DEFAULT_GENERAL_SETTINGS.terminalFontSize &&
    cursorBlink === DEFAULT_GENERAL_SETTINGS.cursorBlink &&
    autoCheckForUpdates === DEFAULT_GENERAL_SETTINGS.autoCheckForUpdates;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">General</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Application-wide preferences are saved automatically on this device.
        </p>
      </div>

      <SettingsGroup
        title="Startup"
        description="Choose what the application restores when it opens."
      >
        <SettingRow
          title="Restore last project"
          description="Select the most recently used project after the project list loads."
        >
          <SettingSwitch
            label="Restore last project"
            checked={restoreLastProject}
            onCheckedChange={(checked) =>
              update({ restoreLastProject: checked })
            }
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title="Terminal"
        description="Defaults for terminal interaction and rendering."
      >
        <SettingRow
          title="Confirm before closing"
          description="Ask before closing a terminal that is starting or still running."
        >
          <SettingSwitch
            label="Confirm before closing a running terminal"
            checked={confirmCloseTerminal}
            onCheckedChange={(checked) =>
              update({ confirmCloseTerminal: checked })
            }
          />
        </SettingRow>
        <SettingRow
          title="Font size"
          description="Applied immediately to every open terminal."
        >
          <select
            aria-label="Terminal font size"
            className="h-9 w-24 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={terminalFontSize}
            onChange={(event) =>
              update({ terminalFontSize: Number(event.target.value) })
            }
          >
            {FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          title="Blinking cursor"
          description="Animate the block cursor while the terminal is focused."
        >
          <SettingSwitch
            label="Blinking terminal cursor"
            checked={cursorBlink}
            onCheckedChange={(checked) => update({ cursorBlink: checked })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title="Projects sidebar"
        description="Control the information shown beside each project."
      >
        <SettingRow
          title="Running terminal count"
          description="Show the number of active terminals next to each project."
        >
          <SettingSwitch
            label="Show running terminal count"
            checked={showTerminalCount}
            onCheckedChange={(checked) =>
              update({ showTerminalCount: checked })
            }
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title="Updates"
        description="Keep Project Terminal up to date from signed GitHub Releases."
      >
        <SettingRow
          title="Automatically check for updates"
          description="Check once whenever the application starts."
        >
          <SettingSwitch
            label="Automatically check for updates"
            checked={autoCheckForUpdates}
            onCheckedChange={(checked) =>
              update({ autoCheckForUpdates: checked })
            }
          />
        </SettingRow>
        <SettingRow
          title="Check for updates"
          description="Check now and install a signed update when one is available."
        >
          <Button variant="outline" size="sm" onClick={requestUpdateCheck}>
            <RefreshCw className="h-4 w-4" /> Check now
          </Button>
        </SettingRow>
      </SettingsGroup>

      <div className="flex justify-end border-t pt-5">
        <Button variant="outline" onClick={reset} disabled={isDefault}>
          <RotateCcw className="h-4 w-4" />
          Restore defaults
        </Button>
      </div>
    </div>
  );
}

function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="border-b bg-muted/20 px-5 py-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="divide-y">{children}</div>
    </section>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-20 items-center gap-6 px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SettingSwitch({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        checked
          ? "border-primary bg-primary"
          : "border-input bg-muted-foreground/25",
      )}
    >
      <span
        className={cn(
          "block h-4 w-4 rounded-full shadow-sm transition-transform",
          checked
            ? "translate-x-6 bg-primary-foreground"
            : "translate-x-1 bg-foreground",
        )}
      />
    </button>
  );
}

import { useCallback, useEffect, useState } from "react";
import {
  Copy,
  Link2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { requestUpdateCheck } from "@/services/updater";
import { remoteAccessService } from "@/services";
import { nativeAppService } from "@/services/native";
import {
  DEFAULT_GENERAL_SETTINGS,
  useSettingsStore,
} from "@/stores/settingsStore";

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24];
const SCROLLBACK_LINES = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000];
const SCROLLBACK_MEGABYTES = [1, 2, 4, 8, 16, 32];

export function GeneralSettingsPanel() {
  const { t } = useTranslation();
  const language = useSettingsStore((state) => state.language);
  const theme = useSettingsStore((state) => state.theme);
  const restoreLastProject = useSettingsStore(
    (state) => state.restoreLastProject,
  );
  const confirmCloseTerminal = useSettingsStore(
    (state) => state.confirmCloseTerminal,
  );
  const confirmDeleteProject = useSettingsStore(
    (state) => state.confirmDeleteProject,
  );
  const showTerminalCount = useSettingsStore(
    (state) => state.showTerminalCount,
  );
  const openFileSidebarByDefault = useSettingsStore(
    (state) => state.openFileSidebarByDefault,
  );
  const terminalFontFamily = useSettingsStore(
    (state) => state.terminalFontFamily,
  );
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const terminalScrollbackLines = useSettingsStore(
    (state) => state.terminalScrollbackLines,
  );
  const terminalScrollbackMegabytes = useSettingsStore(
    (state) => state.terminalScrollbackMegabytes,
  );
  const cursorBlink = useSettingsStore((state) => state.cursorBlink);
  const autoCheckForUpdates = useSettingsStore(
    (state) => state.autoCheckForUpdates,
  );
  const update = useSettingsStore((state) => state.updateGeneralSettings);
  const reset = useSettingsStore((state) => state.resetGeneralSettings);
  const [version, setVersion] = useState("");
  const [remoteInfo, setRemoteInfo] = useState<Awaited<
    ReturnType<typeof remoteAccessService.remoteAccessInfo>
  > | null>(null);
  const [showRemoteToken, setShowRemoteToken] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const handleRemoteError = useCallback(
    (error: unknown) => {
      const message =
        error !== null &&
        typeof error === "object" &&
        "message" in error &&
        typeof error.message === "string"
          ? error.message
          : undefined;
      setRemoteError(message ?? t("Remote gateway is unavailable"));
    },
    [t],
  );
  const loadRemoteInfo = useCallback(() => {
    remoteAccessService
      .remoteAccessInfo()
      .then((info) => {
        setRemoteInfo(info);
        setRemoteError(null);
      })
      .catch(handleRemoteError);
  }, [handleRemoteError]);
  useEffect(() => {
    loadRemoteInfo();
  }, [loadRemoteInfo]);
  useEffect(() => {
    void nativeAppService.version().then(setVersion);
  }, []);

  const isDefault =
    language === DEFAULT_GENERAL_SETTINGS.language &&
    theme === DEFAULT_GENERAL_SETTINGS.theme &&
    restoreLastProject === DEFAULT_GENERAL_SETTINGS.restoreLastProject &&
    confirmCloseTerminal === DEFAULT_GENERAL_SETTINGS.confirmCloseTerminal &&
    confirmDeleteProject === DEFAULT_GENERAL_SETTINGS.confirmDeleteProject &&
    showTerminalCount === DEFAULT_GENERAL_SETTINGS.showTerminalCount &&
    openFileSidebarByDefault ===
      DEFAULT_GENERAL_SETTINGS.openFileSidebarByDefault &&
    terminalFontFamily === DEFAULT_GENERAL_SETTINGS.terminalFontFamily &&
    terminalFontSize === DEFAULT_GENERAL_SETTINGS.terminalFontSize &&
    terminalScrollbackLines ===
      DEFAULT_GENERAL_SETTINGS.terminalScrollbackLines &&
    terminalScrollbackMegabytes ===
      DEFAULT_GENERAL_SETTINGS.terminalScrollbackMegabytes &&
    cursorBlink === DEFAULT_GENERAL_SETTINGS.cursorBlink &&
    autoCheckForUpdates === DEFAULT_GENERAL_SETTINGS.autoCheckForUpdates;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t("General")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Application-wide preferences are saved automatically on this device.",
          )}
        </p>
      </div>

      <SettingsGroup
        title={t("Language")}
        description={t("Choose the language used throughout the application.")}
      >
        <SettingRow
          title={t("Interface language")}
          description={t("Changes apply immediately.")}
        >
          <select
            aria-label={t("Language")}
            className="h-9 w-36 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={language}
            onChange={(event) =>
              update({ language: event.target.value as "en" | "zh-CN" })
            }
          >
            <option value="en">{t("English")}</option>
            <option value="zh-CN">简体中文</option>
          </select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title={t("Startup")}
        description={t("Choose what the application restores when it opens.")}
      >
        <SettingRow
          title={t("Restore last project")}
          description={t(
            "Select the most recently used project after the project list loads.",
          )}
        >
          <SettingSwitch
            label={t("Restore last project")}
            checked={restoreLastProject}
            onCheckedChange={(checked) =>
              update({ restoreLastProject: checked })
            }
          />
        </SettingRow>
        <SettingRow
          title={t("Open file sidebar on startup")}
          description={t(
            "Automatically show the current project's files when the application starts.",
          )}
        >
          <SettingSwitch
            label={t("Open file sidebar on startup")}
            checked={openFileSidebarByDefault}
            onCheckedChange={(checked) =>
              update({ openFileSidebarByDefault: checked })
            }
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title={t("Terminal")}
        description={t("Defaults for terminal interaction and rendering.")}
      >
        <SettingRow
          title={t("Confirm before closing")}
          description={t(
            "Ask before closing a terminal that is starting or still running.",
          )}
        >
          <SettingSwitch
            label={t("Confirm before closing a running terminal")}
            checked={confirmCloseTerminal}
            onCheckedChange={(checked) =>
              update({ confirmCloseTerminal: checked })
            }
          />
        </SettingRow>
        <SettingRow
          title={t("Font size")}
          description={t("Applied immediately to every open terminal.")}
        >
          <select
            aria-label={t("Terminal font size")}
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
          title={t("Blinking cursor")}
          description={t(
            "Animate the block cursor while the terminal is focused.",
          )}
        >
          <SettingSwitch
            label={t("Blinking terminal cursor")}
            checked={cursorBlink}
            onCheckedChange={(checked) => update({ cursorBlink: checked })}
          />
        </SettingRow>
        <SettingRow
          title={t("Visible scrollback")}
          description={t("Maximum history retained by each terminal view.")}
        >
          <select
            aria-label={t("Terminal scrollback lines")}
            className="h-9 w-28 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={terminalScrollbackLines}
            onChange={(event) =>
              update({ terminalScrollbackLines: Number(event.target.value) })
            }
          >
            {SCROLLBACK_LINES.map((lines) => (
              <option key={lines} value={lines}>
                {lines.toLocaleString()}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          title={t("Attach history memory")}
          description={t(
            "Maximum raw output retained for reattaching to a running session.",
          )}
        >
          <select
            aria-label={t("Terminal attach history memory")}
            className="h-9 w-24 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            value={terminalScrollbackMegabytes}
            onChange={(event) =>
              update({
                terminalScrollbackMegabytes: Number(event.target.value),
              })
            }
          >
            {SCROLLBACK_MEGABYTES.map((megabytes) => (
              <option key={megabytes} value={megabytes}>
                {megabytes} MB
              </option>
            ))}
          </select>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title={t("Projects sidebar")}
        description={t("Control the information shown beside each project.")}
      >
        <SettingRow
          title={t("Confirm before deleting projects")}
          description={t(
            "Show a warning before removing a project and its terminal sessions.",
          )}
        >
          <SettingSwitch
            label={t("Confirm before deleting projects")}
            checked={confirmDeleteProject}
            onCheckedChange={(checked) =>
              update({ confirmDeleteProject: checked })
            }
          />
        </SettingRow>
        <SettingRow
          title={t("Running terminal count")}
          description={t(
            "Show the number of active terminals next to each project.",
          )}
        >
          <SettingSwitch
            label={t("Show running terminal count")}
            checked={showTerminalCount}
            onCheckedChange={(checked) =>
              update({ showTerminalCount: checked })
            }
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title={t("Remote access")}
        description={t(
          "The gateway binds to loopback by default. Use Tailscale or an HTTPS reverse proxy for other devices.",
        )}
      >
        <SettingRow
          title={t("Mobile terminal gateway")}
          description={
            remoteInfo
              ? remoteInfo.enabled
                ? `${remoteInfo.url} · ${remoteInfo.transportSecurity}`
                : t("Remote access is disabled.")
              : remoteError
                ? remoteError
                : t("Access details are kept in app memory only.")
          }
        >
          <div className="flex items-center gap-2">
            <SettingSwitch
              label={t("Enable remote access")}
              checked={remoteInfo?.enabled ?? false}
              onCheckedChange={(checked) =>
                void remoteAccessService
                  .setRemoteEnabled(checked)
                  .then((info) => {
                    setRemoteInfo(info);
                    setRemoteError(null);
                  })
                  .catch((error) => {
                    handleRemoteError(error);
                    loadRemoteInfo();
                  })
              }
            />
            <Button variant="outline" size="sm" onClick={loadRemoteInfo}>
              <ShieldCheck className="h-4 w-4" />
              {remoteInfo ? t("Refresh") : t("Show access")}
            </Button>
          </div>
        </SettingRow>
        {remoteInfo?.enabled ? (
          <>
            <SettingRow
              title={t("Allow LAN access")}
              description={t(
                "Expose the gateway to your local network so a phone on the same Wi-Fi can connect. Token and terminal traffic travel in plaintext; only use on trusted networks.",
              )}
            >
              <SettingSwitch
                label={t("Allow LAN access")}
                checked={remoteInfo.allowLan}
                onCheckedChange={(checked) =>
                  void remoteAccessService
                    .setRemoteLanAccess(checked)
                    .then((info) => {
                      setRemoteInfo(info);
                      setRemoteError(null);
                    })
                    .catch((error) => {
                      handleRemoteError(error);
                      loadRemoteInfo();
                    })
                }
              />
            </SettingRow>
            <SettingRow
              title={t("Access token")}
              description={t(
                "This token is not saved to disk. Anyone holding it can view remote sessions.",
              )}
            >
              <div className="flex max-w-sm items-center gap-1">
                <button
                  type="button"
                  onClick={() => setShowRemoteToken((visible) => !visible)}
                  className="h-9 min-w-0 flex-1 truncate rounded-md border border-input bg-background px-2 text-left font-mono text-xs hover:bg-accent"
                  aria-label={t("Show or hide token")}
                  title={t("Show or hide token")}
                >
                  {showRemoteToken
                    ? remoteInfo.token
                    : `••••••••${remoteInfo.token.slice(-4)}`}
                </button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  aria-label={t("Copy token")}
                  onClick={() =>
                    void navigator.clipboard.writeText(remoteInfo.token)
                  }
                >
                  <Copy />
                </Button>
              </div>
            </SettingRow>
            <SettingRow
              title={t("Scan to connect")}
              description={
                remoteInfo.transportSecurity === "loopback"
                  ? t(
                      "The phone cannot reach 127.0.0.1. Use Tailscale or an HTTPS reverse proxy; the QR code works only after the gateway is reachable from the phone.",
                    )
                  : t(
                      "Scan with a phone camera to open the mobile terminal. The phone must be able to reach this address.",
                    )
              }
            >
              <div className="flex w-32 flex-col items-center gap-2">
                <div className="rounded-md border border-input p-2">
                  <QRCodeSVG
                    value={`${remoteInfo.url}/?token=${encodeURIComponent(remoteInfo.token)}`}
                    size={128}
                    level="M"
                  />
                </div>
                {remoteInfo.transportSecurity === "loopback" ? (
                  <span className="flex items-center gap-1 rounded border border-danger px-1.5 py-0.5 text-[10px] font-medium text-danger">
                    <WifiOff className="h-3 w-3" />
                    {t("Unreachable")}
                  </span>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      `${remoteInfo.url}/?token=${encodeURIComponent(remoteInfo.token)}`,
                    )
                  }
                >
                  <Link2 className="h-4 w-4" />
                  {t("Copy link")}
                </Button>
              </div>
            </SettingRow>
          </>
        ) : null}
      </SettingsGroup>

      <SettingsGroup
        title={t("Updates")}
        description={t("Current version: {version}", {
          version: version || "…",
        })}
      >
        <SettingRow
          title={t("Automatically check for updates")}
          description={t("Check once whenever the application starts.")}
        >
          <SettingSwitch
            label={t("Automatically check for updates")}
            checked={autoCheckForUpdates}
            onCheckedChange={(checked) =>
              update({ autoCheckForUpdates: checked })
            }
          />
        </SettingRow>
        <SettingRow
          title={t("Check for updates")}
          description={t(
            "Check now and install a signed update when one is available.",
          )}
        >
          <Button variant="outline" size="sm" onClick={requestUpdateCheck}>
            <RefreshCw className="h-4 w-4" /> {t("Check now")}
          </Button>
        </SettingRow>
      </SettingsGroup>

      <div className="flex justify-end border-t pt-5">
        <Button variant="outline" onClick={reset} disabled={isDefault}>
          <RotateCcw className="h-4 w-4" />
          {t("Restore defaults")}
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
          "block h-4 w-4 rounded-full transition-transform",
          checked
            ? "translate-x-6 bg-primary-foreground"
            : "translate-x-1 bg-foreground",
        )}
      />
    </button>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, FileUp, MonitorCog, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import {
  ANSI_SWATCH_KEYS,
  BUILT_IN_COLOR_SCHEMES,
  FOLLOW_APP_THEME,
  resolveColorScheme,
  type TerminalColorScheme,
} from "@/lib/terminalColorSchemes";
import { cn } from "@/lib/utils";
import { colorSchemeService } from "@/services";
import { nativeDialogService } from "@/services/native";
import { useColorSchemeStore } from "@/stores/colorSchemeStore";
import { useSettingsStore } from "@/stores/settingsStore";

import { TerminalFontPicker } from "./TerminalFontPicker";

/**
 * Appearance settings: the terminal's palette and typeface.
 *
 * The palette used to be the application theme, which meant three of them and
 * no way to run dark chrome around a light terminal. It is its own setting
 * now, still defaulting to following the theme so nothing changes for an
 * existing installation until the user chooses.
 */
export function AppearanceSettingsPanel() {
  const { t } = useTranslation();
  const theme = useSettingsStore((state) => state.theme);
  const selected = useSettingsStore((state) => state.terminalColorScheme);
  const update = useSettingsStore((state) => state.updateGeneralSettings);
  const imported = useColorSchemeStore((state) => state.schemes);
  const loadSchemes = useColorSchemeStore((state) => state.load);
  const removeScheme = useColorSchemeStore((state) => state.remove);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadSchemes();
  }, [loadSchemes]);

  const report = useCallback(
    (cause: unknown) => {
      const detail =
        cause !== null &&
        typeof cause === "object" &&
        "message" in cause &&
        typeof cause.message === "string"
          ? cause.message
          : undefined;
      setError(detail ?? t("Could not import color schemes."));
    },
    [t],
  );

  const importFromWindowsTerminal = useCallback(async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const scan = await colorSchemeService.scanWindowsTerminal();
      const keys = scan.candidates
        .filter((candidate) => !candidate.alreadyExists)
        .map((candidate) => candidate.key);
      if (keys.length === 0) {
        setMessage(t("No new Windows Terminal color schemes to import."));
        return;
      }
      const result = await colorSchemeService.importWindowsTerminal(keys);
      await loadSchemes();
      setMessage(
        t("Imported {count} color scheme(s).", {
          count: result.imported.length,
        }),
      );
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }, [loadSchemes, report, t]);

  const importFromFile = useCallback(async () => {
    const path = await nativeDialogService.selectFile(t("Color scheme"), [
      "json",
    ]);
    if (!path) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const added = await colorSchemeService.importFromFile(path);
      await loadSchemes();
      setMessage(
        t("Imported {count} color scheme(s).", { count: added.length }),
      );
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }, [loadSchemes, report, t]);

  const active = resolveColorScheme(selected, theme, imported);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t("Appearance")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Choose the colors used by the interface and terminal.")}
        </p>
      </div>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">{t("Interface theme")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Applies to the window, sidebars, and dialogs.")}
          </p>
        </div>
        <select
          aria-label={t("Theme")}
          className="h-9 w-56 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={theme}
          onChange={(event) =>
            update({
              theme: event.target.value as "dark" | "eye-care" | "light",
            })
          }
        >
          <option value="dark">{t("Dark")}</option>
          <option value="eye-care">{t("Warm eye care")}</option>
          <option value="light">{t("White")}</option>
        </select>
      </section>

      <section className="space-y-3 border-t pt-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium">{t("Terminal colors")}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("Applied immediately to every open terminal.")}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void importFromWindowsTerminal()}
            >
              <MonitorCog className="mr-1.5 h-3.5 w-3.5" />
              {t("Import from Windows Terminal")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void importFromFile()}
            >
              <FileUp className="mr-1.5 h-3.5 w-3.5" />
              {t("Import from file")}
            </Button>
          </div>
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="text-sm text-muted-foreground" role="status">
            {message}
          </p>
        ) : null}

        <div
          className="grid gap-3 sm:grid-cols-2"
          role="radiogroup"
          aria-label={t("Terminal color scheme")}
        >
          <SchemeCard
            name={t("Follow interface theme")}
            scheme={resolveColorScheme(FOLLOW_APP_THEME, theme)}
            selected={selected === FOLLOW_APP_THEME}
            onSelect={() => update({ terminalColorScheme: FOLLOW_APP_THEME })}
          />
          {BUILT_IN_COLOR_SCHEMES.map((scheme) => (
            <SchemeCard
              key={scheme.id}
              name={scheme.name}
              scheme={scheme}
              selected={selected === scheme.id}
              onSelect={() => update({ terminalColorScheme: scheme.id })}
            />
          ))}
          {imported.map((scheme) => (
            <SchemeCard
              key={scheme.id}
              name={scheme.name}
              scheme={scheme}
              selected={selected === scheme.id}
              onSelect={() => update({ terminalColorScheme: scheme.id })}
              onDelete={() => {
                void removeScheme(scheme.id).then(() => {
                  // Selecting a scheme that no longer exists would silently
                  // fall back; make the change visible in the picker instead.
                  if (selected === scheme.id) {
                    update({ terminalColorScheme: FOLLOW_APP_THEME });
                  }
                });
              }}
            />
          ))}
        </div>

        {active.attribution ? (
          <p className="text-xs text-muted-foreground">
            {t("{scheme} by {author}", {
              scheme: active.name,
              author: active.attribution,
            })}
          </p>
        ) : null}
      </section>

      <section className="space-y-3 border-t pt-6">
        <div>
          <h3 className="text-sm font-medium">{t("Terminal font")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Applied immediately to every open terminal. Only monospaced fonts installed on this machine are listed.",
            )}
          </p>
        </div>
        <TerminalFontPicker />
        <TypographyControls />
      </section>
    </div>
  );
}

/**
 * The rest of the terminal's typography.
 *
 * Every one of these is applied to the live terminal by assignment - xterm
 * only requires a rebuild for `allowTransparency` and `allowProposedApi` - so
 * the effect is immediate and nothing is torn down.
 */
function TypographyControls() {
  const { t } = useTranslation();
  const settings = useSettingsStore(
    useShallow((state) => ({
      fontWeight: state.terminalFontWeight,
      fontWeightBold: state.terminalFontWeightBold,
      lineHeight: state.terminalLineHeight,
      letterSpacing: state.terminalLetterSpacing,
      cursorStyle: state.terminalCursorStyle,
      cursorInactiveStyle: state.terminalCursorInactiveStyle,
      padding: state.terminalPadding,
      minimumContrast: state.terminalMinimumContrast,
      renderer: state.terminalRenderer,
      pasteShortcut: state.terminalPasteShortcut,
    })),
  );
  const update = useSettingsStore((state) => state.updateGeneralSettings);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Labelled label={t("Text weight")}>
        <NumberSelect
          label={t("Terminal text weight")}
          value={settings.fontWeight}
          options={[200, 300, 400, 500, 600, 700]}
          onChange={(terminalFontWeight) => update({ terminalFontWeight })}
        />
      </Labelled>
      <Labelled label={t("Bold weight")}>
        <NumberSelect
          label={t("Terminal bold weight")}
          value={settings.fontWeightBold}
          options={[400, 500, 600, 700, 800, 900]}
          onChange={(terminalFontWeightBold) =>
            update({ terminalFontWeightBold })
          }
        />
      </Labelled>
      <Labelled label={t("Line height")}>
        <NumberSelect
          label={t("Terminal line height")}
          value={settings.lineHeight}
          options={[1, 1.1, 1.2, 1.3, 1.4, 1.6, 1.8]}
          onChange={(terminalLineHeight) => update({ terminalLineHeight })}
        />
      </Labelled>
      <Labelled label={t("Letter spacing")}>
        <NumberSelect
          label={t("Terminal letter spacing")}
          value={settings.letterSpacing}
          options={[-1, -0.5, 0, 0.5, 1, 2, 3]}
          format={(value) => `${value > 0 ? "+" : ""}${value}px`}
          onChange={(terminalLetterSpacing) =>
            update({ terminalLetterSpacing })
          }
        />
      </Labelled>
      <Labelled label={t("Padding")}>
        <NumberSelect
          label={t("Terminal padding")}
          value={settings.padding}
          options={[0, 4, 6, 8, 10, 12, 16, 24]}
          format={(value) => `${value}px`}
          onChange={(terminalPadding) => update({ terminalPadding })}
        />
      </Labelled>
      <Labelled label={t("Cursor")}>
        <select
          aria-label={t("Terminal cursor style")}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={settings.cursorStyle}
          onChange={(event) =>
            update({
              terminalCursorStyle: event.target
                .value as typeof settings.cursorStyle,
            })
          }
        >
          <option value="block">{t("Block")}</option>
          <option value="bar">{t("Bar")}</option>
          <option value="underline">{t("Underline")}</option>
        </select>
      </Labelled>
      <Labelled
        label={t("Unfocused cursor")}
        hint={t("How the cursor draws in a split pane you are not typing in.")}
      >
        <select
          aria-label={t("Terminal unfocused cursor style")}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={settings.cursorInactiveStyle}
          onChange={(event) =>
            update({
              terminalCursorInactiveStyle: event.target
                .value as typeof settings.cursorInactiveStyle,
            })
          }
        >
          <option value="outline">{t("Outline")}</option>
          <option value="block">{t("Block")}</option>
          <option value="bar">{t("Bar")}</option>
          <option value="underline">{t("Underline")}</option>
          <option value="none">{t("Hidden")}</option>
        </select>
      </Labelled>
      <Labelled
        label={t("Renderer")}
        hint={t(
          "Switch to software rendering if the terminal flickers or leaves artifacts.",
        )}
      >
        <select
          aria-label={t("Terminal renderer")}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={settings.renderer}
          onChange={(event) =>
            update({
              terminalRenderer: event.target.value as typeof settings.renderer,
            })
          }
        >
          <option value="auto">
            {t("Automatic (hardware when available)")}
          </option>
          <option value="webgl">{t("Hardware (WebGL)")}</option>
          <option value="dom">{t("Software (DOM)")}</option>
        </select>
      </Labelled>
      <Labelled
        label={t("Paste shortcut")}
        hint={t(
          "Ctrl+Shift+V leaves Ctrl+V to programs such as vim and emacs.",
        )}
      >
        <select
          aria-label={t("Terminal paste shortcut")}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={settings.pasteShortcut}
          onChange={(event) =>
            update({
              terminalPasteShortcut: event.target
                .value as typeof settings.pasteShortcut,
            })
          }
        >
          <option value="ctrl-v">Ctrl+V</option>
          <option value="ctrl-shift-v">Ctrl+Shift+V</option>
        </select>
      </Labelled>
      <Labelled
        label={t("Minimum contrast")}
        hint={t(
          "Raise this when a tool prints dim colors that are hard to read.",
        )}
      >
        <select
          aria-label={t("Terminal minimum contrast")}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
          value={settings.minimumContrast}
          onChange={(event) =>
            update({ terminalMinimumContrast: Number(event.target.value) })
          }
        >
          <option value={0}>{t("Match the color scheme")}</option>
          <option value={1}>{t("Off")}</option>
          <option value={4.5}>{t("Readable (4.5:1)")}</option>
          <option value={7}>{t("High (7:1)")}</option>
        </select>
      </Labelled>
    </div>
  );
}

function Labelled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint ? (
        <span className="block text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

function NumberSelect({
  label,
  value,
  options,
  format = String,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  // A saved value outside the offered set - from a future build, or a hand
  // edit - still has to be selectable or the control would silently move it.
  const choices = options.includes(value)
    ? options
    : [...options, value].sort((a, b) => a - b);
  return (
    <select
      aria-label={label}
      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {choices.map((option) => (
        <option key={option} value={option}>
          {format(option)}
        </option>
      ))}
    </select>
  );
}

/**
 * One scheme, previewed in its own colours.
 *
 * A name alone does not say what a palette looks like, so the card renders a
 * line of terminal-shaped text and the full ANSI grid on the scheme's own
 * background - which is also the only way to see that an imported scheme is
 * unreadable before selecting it.
 */
function SchemeCard({
  name,
  scheme,
  selected,
  onSelect,
  onDelete,
}: {
  name: string;
  scheme: TerminalColorScheme;
  selected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = scheme;
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-md border text-left transition-colors",
        selected ? "border-primary ring-1 ring-primary" : "border-border",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onSelect}
        style={{ background: theme.background, color: theme.foreground }}
      >
        <div className="space-y-2 px-3 py-2.5 font-mono text-xs">
          <div className="flex items-center gap-1.5">
            <span style={{ color: theme.green }}>~/project</span>
            <span style={{ color: theme.blue }}>git:(</span>
            <span style={{ color: theme.red }}>main</span>
            <span style={{ color: theme.blue }}>)</span>
            <span style={{ color: theme.brightBlack }}>$</span>
          </div>
          <div className="flex gap-px">
            {ANSI_SWATCH_KEYS.map((key) => (
              <span
                key={key}
                className="h-3 flex-1"
                style={{ background: theme[key] as string }}
              />
            ))}
          </div>
        </div>
      </button>
      <div className="flex items-center justify-between gap-2 border-t border-border bg-surface px-3 py-1.5">
        <span className="truncate text-xs font-medium">{name}</span>
        <div className="flex items-center gap-1">
          {selected ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
          {onDelete ? (
            <button
              type="button"
              aria-label={t("Delete {scheme}", { scheme: name })}
              className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

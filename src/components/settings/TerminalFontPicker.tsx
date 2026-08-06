import { useEffect, useMemo, useState } from "react";
import { Check, TriangleAlert } from "lucide-react";

import { useTranslation } from "@/i18n";
import {
  BUNDLED_TERMINAL_FONT,
  buildTerminalFontStack,
  detectAvailableMonospaceFonts,
  FONT_PREVIEW_LINES,
  hasNerdFontGlyphs,
  whenTerminalFontReady,
} from "@/lib/terminalFonts";
import { useSettingsStore } from "@/stores/settingsStore";

/**
 * Pick the terminal font, and show what the choice does to a shell prompt.
 *
 * The preview is the point. "Which monospace font" is not a question most
 * people can answer from a name, but "do my prompt's icons render or come out
 * as boxes" is immediately visible - and it is the actual complaint behind
 * most terminal font changes.
 */
export function TerminalFontPicker() {
  const { t } = useTranslation();
  const terminalFontFamily = useSettingsStore(
    (state) => state.terminalFontFamily,
  );
  const terminalFontSize = useSettingsStore((state) => state.terminalFontSize);
  const update = useSettingsStore((state) => state.updateGeneralSettings);
  const [available, setAvailable] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    // `document.fonts.ready` alone is not enough. It resolves once loads
    // already in flight finish, and a `font-display: block` webfont nothing
    // has asked for yet is not in flight - so the bundled family would probe
    // as missing, in its own picker.
    void whenTerminalFontReady().then(() => {
      if (!cancelled) setAvailable(detectAvailableMonospaceFonts());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveFamily = terminalFontFamily || BUNDLED_TERMINAL_FONT;
  const fontStack = useMemo(
    () => buildTerminalFontStack(terminalFontFamily),
    [terminalFontFamily],
  );
  // Recomputed alongside the probe results so the badge is not answered from
  // an empty font set on the first render.
  const nerdFontGlyphs = useMemo(
    () => available.length > 0 && hasNerdFontGlyphs(effectiveFamily),
    [available, effectiveFamily],
  );

  // A family saved on another machine, or one uninstalled since, still has to
  // appear or the select would silently snap to something else.
  const options = useMemo(() => {
    const names = new Set(available);
    if (terminalFontFamily) names.add(terminalFontFamily);
    names.delete(BUNDLED_TERMINAL_FONT);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [available, terminalFontFamily]);

  return (
    <div className="space-y-3">
      <select
        aria-label={t("Terminal font")}
        className="h-9 w-56 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        value={terminalFontFamily}
        onChange={(event) => update({ terminalFontFamily: event.target.value })}
      >
        <option value="">
          {t("{font} (bundled)", { font: BUNDLED_TERMINAL_FONT })}
        </option>
        {options.map((family) => (
          <option key={family} value={family}>
            {family}
          </option>
        ))}
      </select>

      <div
        className="rounded-md border border-border bg-surface px-3 py-2 leading-relaxed"
        style={{ fontFamily: fontStack, fontSize: `${terminalFontSize}px` }}
      >
        {FONT_PREVIEW_LINES.map((line, index) => (
          <div key={index} className="whitespace-pre">
            {line}
          </div>
        ))}
      </div>

      <p
        className={
          nerdFontGlyphs
            ? "flex items-center gap-1.5 text-xs text-ok"
            : "flex items-center gap-1.5 text-xs text-warn"
        }
      >
        {nerdFontGlyphs ? (
          <Check className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
        )}
        {nerdFontGlyphs
          ? t("Prompt icons available — starship and oh-my-posh will render.")
          : t(
              "This font has no prompt icons. The third line above will show boxes in starship and oh-my-posh.",
            )}
      </p>
    </div>
  );
}

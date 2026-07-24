import {
  clampTerminalFontSize,
  clampTerminalScrollbackLines,
  clampTerminalScrollbackMegabytes,
  DEFAULT_GENERAL_SETTINGS,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_SCROLLBACK_LINES,
  MAX_TERMINAL_SCROLLBACK_MEGABYTES,
  MIN_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_SCROLLBACK_MEGABYTES,
  useSettingsStore,
} from "@/stores/settingsStore";

describe("settingsStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      ...DEFAULT_GENERAL_SETTINGS,
      lastProjectId: null,
    });
  });

  it("updates and resets general settings", () => {
    useSettingsStore.getState().updateGeneralSettings({
      language: "zh-CN",
      theme: "eye-care",
      cursorBlink: false,
      terminalFontSize: 18,
      autoCheckForUpdates: false,
    });

    expect(useSettingsStore.getState().language).toBe("zh-CN");
    expect(useSettingsStore.getState().theme).toBe("eye-care");
    expect(useSettingsStore.getState().cursorBlink).toBe(false);
    expect(useSettingsStore.getState().terminalFontSize).toBe(18);
    expect(useSettingsStore.getState().autoCheckForUpdates).toBe(false);

    useSettingsStore.getState().resetGeneralSettings();
    expect(useSettingsStore.getState()).toMatchObject(DEFAULT_GENERAL_SETTINGS);
  });

  it("clamps invalid terminal font sizes", () => {
    expect(clampTerminalFontSize(1)).toBe(MIN_TERMINAL_FONT_SIZE);
    expect(clampTerminalFontSize(100)).toBe(MAX_TERMINAL_FONT_SIZE);
    expect(clampTerminalFontSize(Number.NaN)).toBe(
      DEFAULT_GENERAL_SETTINGS.terminalFontSize,
    );
  });

  it("clamps terminal scrollback settings", () => {
    expect(clampTerminalScrollbackLines(1)).toBe(
      MIN_TERMINAL_SCROLLBACK_LINES,
    );
    expect(clampTerminalScrollbackLines(1_000_000)).toBe(
      MAX_TERMINAL_SCROLLBACK_LINES,
    );
    expect(clampTerminalScrollbackMegabytes(0)).toBe(
      MIN_TERMINAL_SCROLLBACK_MEGABYTES,
    );
    expect(clampTerminalScrollbackMegabytes(100)).toBe(
      MAX_TERMINAL_SCROLLBACK_MEGABYTES,
    );
  });

  it("remembers the last selected project independently of reset", () => {
    useSettingsStore.getState().rememberProject("project-1");
    useSettingsStore.getState().updateGeneralSettings({ cursorBlink: false });
    useSettingsStore.getState().resetGeneralSettings();

    expect(useSettingsStore.getState().lastProjectId).toBe("project-1");
    expect(useSettingsStore.getState().cursorBlink).toBe(true);
  });
});

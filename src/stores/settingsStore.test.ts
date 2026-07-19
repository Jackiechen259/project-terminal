import {
  clampTerminalFontSize,
  DEFAULT_GENERAL_SETTINGS,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
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
      cursorBlink: false,
      terminalFontSize: 18,
    });

    expect(useSettingsStore.getState().cursorBlink).toBe(false);
    expect(useSettingsStore.getState().terminalFontSize).toBe(18);

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

  it("remembers the last selected project independently of reset", () => {
    useSettingsStore.getState().rememberProject("project-1");
    useSettingsStore.getState().updateGeneralSettings({ cursorBlink: false });
    useSettingsStore.getState().resetGeneralSettings();

    expect(useSettingsStore.getState().lastProjectId).toBe("project-1");
    expect(useSettingsStore.getState().cursorBlink).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { preloadLanguage, translate } from "./index";

describe("translate", () => {
  it("falls back to the source text before the dictionary has loaded", () => {
    // `zh-CN` is dynamically imported (see src/i18n/locales/zh-CN.ts) - a
    // known key still translates as a no-op on the very first call, before
    // the background load this same call kicks off (verified via
    // `preloadLanguage` in the next test) has had a chance to resolve.
    expect(translate("zh-CN", "Settings")).toBe("Settings");
  });

  it("returns Chinese translations and falls back to the source text", async () => {
    await preloadLanguage("zh-CN");
    expect(translate("zh-CN", "Settings")).toBe("设置");
    expect(translate("zh-CN", "Unknown text")).toBe("Unknown text");
    expect(translate("en", "Settings")).toBe("Settings");
  });

  it("interpolates named parameters", async () => {
    await preloadLanguage("zh-CN");
    expect(
      translate("zh-CN", "Project Terminal {version} is ready to install.", {
        version: "1.2.3",
      }),
    ).toBe("Project Terminal 1.2.3 已可安装。");
  });
});

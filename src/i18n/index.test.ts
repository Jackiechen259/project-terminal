import { describe, expect, it } from "vitest";

import { translate } from "./index";

describe("translate", () => {
  it("returns Chinese translations and falls back to the source text", () => {
    expect(translate("zh-CN", "Settings")).toBe("设置");
    expect(translate("zh-CN", "Unknown text")).toBe("Unknown text");
    expect(translate("en", "Settings")).toBe("Settings");
  });

  it("interpolates named parameters", () => {
    expect(
      translate("zh-CN", "Project Terminal {version} is ready to install.", {
        version: "1.2.3",
      }),
    ).toBe("Project Terminal 1.2.3 已可安装。");
  });
});

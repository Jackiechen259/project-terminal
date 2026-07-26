import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "index.html"), "utf8");

describe("startup shell", () => {
  it("renders a draggable title bar before the application module loads", () => {
    const document = new DOMParser().parseFromString(source, "text/html");
    const titleBar = document.querySelector(".startup-titlebar");

    expect(titleBar).not.toBeNull();
    expect(titleBar?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(source.indexOf("startup-titlebar")).toBeLessThan(
      source.indexOf('src="/src/main.tsx"'),
    );
  });

  it("restores the persisted theme before the first frame is styled", () => {
    expect(source).toContain("project-terminal.general-settings");
    expect(source).toContain("--startup-background");
    expect(source.indexOf("project-terminal.general-settings")).toBeLessThan(
      source.indexOf("<style>"),
    );
  });

  it("shows a motion-safe terminal animation while React is loading", () => {
    const document = new DOMParser().parseFromString(source, "text/html");

    expect(document.querySelector(".startup-loader")).not.toBeNull();
    expect(document.querySelector(".startup-terminal")).not.toBeNull();
    expect(document.querySelector(".startup-progress")).not.toBeNull();
    expect(source).toContain("@keyframes startup-progress");
    expect(source).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

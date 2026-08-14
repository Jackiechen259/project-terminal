import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { MarkdownMemoPreview } from "./MarkdownMemoPreview";

const GFM_SAMPLE = `# Heading

**bold** and *italic*

- list one
- list two

1. first
2. second

- [ ] open task
- [x] done task

\`inline code\`

\`\`\`bash
pnpm dev
\`\`\`

> quote

[link](https://example.com)

| Name | Value |
| ---- | ----- |
| a    | 1     |
`;

describe("MarkdownMemoPreview", () => {
  it("renders headings, emphasis, lists, task lists, code, quotes, links, and GFM tables", () => {
    const { container } = render(<MarkdownMemoPreview content={GFM_SAMPLE} />);

    expect(container.querySelector("h1")?.textContent).toBe("Heading");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelectorAll("ul li")).toHaveLength(4); // 2 list + 2 task
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    const tasks = container.querySelectorAll('input[type="checkbox"]');
    expect(tasks).toHaveLength(2);
    expect((tasks[0] as HTMLInputElement).checked).toBe(false);
    expect((tasks[1] as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector("pre code")?.textContent).toContain(
      "pnpm dev",
    );
    expect(container.querySelector("blockquote")?.textContent).toContain(
      "quote",
    );
    expect(container.querySelector('a[href="https://example.com"]')).not.toBe(
      null,
    );
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelector("th")?.textContent).toBe("Name");
  });

  it("never executes raw HTML from memo content", () => {
    const { container } = render(
      <MarkdownMemoPreview
        content={
          '# Safe\n\n<script>window.__memoPwned = true</script>\n\n<img src=x onerror="window.__memoPwned = true">'
        }
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect((window as { __memoPwned?: boolean }).__memoPwned).toBeUndefined();
  });

  it("strips javascript: protocols from links", () => {
    const { container } = render(
      <MarkdownMemoPreview content={"[bad](javascript:alert(1))"} />,
    );
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });

  it("renders an empty document without crashing", () => {
    const { container } = render(<MarkdownMemoPreview content="" />);
    expect(container.querySelector(".memo-markdown")).not.toBeNull();
  });
});

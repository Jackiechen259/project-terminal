import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { terminalService } from "@/services";

/**
 * Renders memo markdown with GFM support (tables, task lists, strikethrough).
 *
 * Security: react-markdown never renders raw HTML without `rehype-raw`, which
 * this component deliberately does not use, so `<script>` blocks and inline
 * event handlers stay inert. Link URLs are sanitized by react-markdown's
 * built-in URL transform, and clicks are routed through the backend's
 * `open_external_url` (which re-validates the scheme) instead of navigating
 * the WebView - the same convention as terminal links.
 */
export function MarkdownMemoPreview({ content }: { content: string }) {
  return (
    <div className="memo-markdown min-w-0 flex-1 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: MemoLink,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function MemoLink({ href, children, ...rest }: ComponentPropsWithoutRef<"a">) {
  return (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        if (!href || href.startsWith("#")) return;
        event.preventDefault();
        void terminalService.openExternalUrl(href).catch(() => {
          // The backend refuses anything that is not plainly an http(s) URL.
        });
      }}
    >
      {children}
    </a>
  );
}

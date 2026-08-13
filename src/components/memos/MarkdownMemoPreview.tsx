import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders memo markdown with GFM support (tables, task lists, strikethrough).
 *
 * Security: react-markdown never renders raw HTML without `rehype-raw`, which
 * this component deliberately does not use, so `<script>` blocks and inline
 * event handlers stay inert. Link URLs are sanitized by react-markdown's
 * built-in URL transform.
 */
export function MarkdownMemoPreview({ content }: { content: string }) {
  return (
    <div className="memo-markdown min-w-0 flex-1 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

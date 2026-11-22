// From engenty wizards, packages/runner/src/outputs.tsx (`Markdown`).
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";
import { cn } from "./index";

// A link leaves the chat standing: it opens in a tab of its own.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Markdown someone else wrote (an agent, the person), drawn as HTML that DOMPurify has cleaned. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(
    // `breaks`: a line break in a message is a line break on the page.
    () => DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true })),
    [text],
  );
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised by DOMPurify above
    <div className={cn("prose-zen", className)} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

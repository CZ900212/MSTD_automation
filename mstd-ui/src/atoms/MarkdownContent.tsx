import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const MarkdownContent = React.memo(function MarkdownContent(
  { text, pending }: { text: string; pending?: boolean }
) {
  if (pending) return <p className="pending-text">{text}</p>;
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { SyntaxHighlighter } from "../lib/syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import ImageLightbox from "./ImageLightbox";

const remarkPlugins = [remarkGfm];

// Module scope on purpose: a new component function is a new element type to React, so
// defining these during render remounts the whole message each time, which reloads
// its images and drops the user's text selection.
const components: Components = {
  p({ children }) {
    return <p className="my-2 first:mt-0 last:mb-0">{children}</p>;
  },
  h1({ children }) {
    return (
      <h1 className="mt-4 mb-2 first:mt-0 text-lg font-medium leading-snug text-text-primary">
        {children}
      </h1>
    );
  },
  h2({ children }) {
    return (
      <h2 className="mt-4 mb-2 first:mt-0 text-base font-medium leading-snug text-text-primary">
        {children}
      </h2>
    );
  },
  h3({ children }) {
    return (
      <h3 className="mt-3 mb-1.5 first:mt-0 text-sm font-medium leading-snug text-text-primary">
        {children}
      </h3>
    );
  },
  ul({ children }) {
    return <ul className="my-2 ml-4 list-disc space-y-1 marker:text-text-muted">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="my-2 ml-4 list-decimal space-y-1 marker:text-text-muted">{children}</ol>;
  },
  li({ children }) {
    return <li className="pl-1">{children}</li>;
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 border-l-2 border-white/14 pl-3 text-text-muted">
        {children}
      </blockquote>
    );
  },
  strong({ children }) {
    return <strong className="font-semibold text-text-primary">{children}</strong>;
  },
  code({ className, children, ...rest }) {
    const match = /language-(\w+)/.exec(className || "");
    const inline = !className;
    if (inline) {
      return (
        <code
          className="bg-raised px-1.5 py-0.5 rounded-xs text-[0.85em] text-text-primary border border-border"
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <SyntaxHighlighter
        style={oneDark}
        language={match?.[1] ?? "text"}
        PreTag="div"
        customStyle={{
          margin: "0.5em 0",
          borderRadius: 8,
          fontSize: "0.85em",
          background: "var(--color-surface-alt)",
          border: "1px solid var(--color-border)",
        }}
        // The theme paints the inner <code> too, which shows as a box behind every line.
        codeTagProps={{ style: { background: "transparent" } }}
      >
        {String(children).replace(/\n$/, "")}
      </SyntaxHighlighter>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-text-primary underline decoration-white/24 underline-offset-2 transition-colors hover:decoration-text-primary"
      >
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    return <ImageLightbox src={src} alt={alt} />;
  },
  table({ children }) {
    return (
      <div className="my-2 max-w-full overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          {children}
        </table>
      </div>
    );
  },
  th({ children }) {
    return (
      <th className="border border-border px-3 py-1.5 bg-raised text-left font-medium text-text-primary">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="border border-border px-3 py-1.5 text-text-secondary tabular-nums">
        {children}
      </td>
    );
  },
};

function Markdown({ children }: { children: string }) {
  return (
    <div className="chomp-markdown text-sm leading-relaxed text-text-secondary">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);

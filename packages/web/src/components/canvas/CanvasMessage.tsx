// Renders a message that may contain :::canvas blocks mixed with markdown.
// Splits content into segments and renders each appropriately.

import { parseCanvasContent } from "../../lib/canvas-parser";
import CanvasRenderer from "./CanvasRenderer";
import Markdown from "../Markdown";

interface CanvasMessageProps {
  content: string;
}

export default function CanvasMessage({ content }: CanvasMessageProps) {
  const segments = parseCanvasContent(content);

  return (
    <div className="flex flex-col gap-2">
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <Markdown key={i}>{seg.content}</Markdown>
        ) : (
          <CanvasRenderer key={i} data={seg.data} />
        )
      )}
    </div>
  );
}

// Tab container — switches between content panels locally.

import { useState } from "react";
import Markdown from "../Markdown";
import { GlassCard } from "../ui";
import { hue } from "./colors";

interface Tab {
  label: string;
  content: string;
}

interface TabsProps {
  tabs: Tab[];
  color?: string;
}

export default function Tabs({ tabs, color }: TabsProps) {
  const [activeIndex, setActiveIndex] = useState(0);

  if (!tabs.length) return null;

  return (
    <GlassCard className="overflow-hidden">
      <div role="tablist" className="flex border-b border-border px-2 overflow-x-auto">
        {tabs.map((tab, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            aria-selected={i === activeIndex}
            onClick={() => setActiveIndex(i)}
            className={`relative h-9 px-3 shrink-0 bg-transparent border-none text-[13px] transition-colors cursor-pointer ${
              i === activeIndex ? "text-text-primary" : "text-text-muted hover:text-text-secondary"
            }`}
          >
            {tab.label}
            {i === activeIndex && (
              <span className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full" style={{ backgroundColor: hue(color) }} />
            )}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="px-4 py-3">
        <Markdown>{tabs[activeIndex].content}</Markdown>
      </div>
    </GlassCard>
  );
}

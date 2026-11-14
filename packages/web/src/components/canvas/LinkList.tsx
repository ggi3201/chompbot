// Link list — titled list of labeled links for search results, resources.

import { GlassCard } from "../ui";

interface LinkItem {
  label: string;
  url: string;
  description?: string;
}

interface LinkListProps {
  title?: string;
  items: LinkItem[];
}

export default function LinkList({ title, items }: LinkListProps) {
  return (
    <GlassCard className="overflow-hidden">
      {title && <div className="px-4 py-2.5 border-b border-border text-[13px] text-text-secondary">{title}</div>}
      <div className="divide-y divide-border">
        {items.map((item, i) => (
          <a
            key={i}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block px-4 py-2.5 no-underline hover:bg-glass-hover transition-colors"
          >
            <div className="text-sm text-text-primary">{item.label}</div>
            {item.description && <div className="text-xs text-text-muted mt-0.5 line-clamp-1">{item.description}</div>}
          </a>
        ))}
      </div>
    </GlassCard>
  );
}

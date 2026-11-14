// Responsive grid of InfoCards — for dashboards, portfolio views, etc.

import InfoCard from "./InfoCard";

interface MetricItem {
  title: string;
  value: string;
  subtitle?: string;
  change?: string;
  color?: string;
}

interface MetricGridProps {
  items: MetricItem[];
  columns?: number;
}

const GRID_COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  4: "grid-cols-2 md:grid-cols-4",
};

export default function MetricGrid({ items, columns }: MetricGridProps) {
  const cols = columns ?? Math.min(items.length, 3);

  return (
    <div className={`grid ${GRID_COLUMNS[cols] ?? "grid-cols-2 md:grid-cols-3"} gap-2`}>
      {items.map((item, i) => (
        <InfoCard key={i} {...item} />
      ))}
    </div>
  );
}

// Styled data table — headers + rows for structured data.

import { GlassCard } from "../ui";

interface DataTableProps {
  title?: string;
  headers: string[];
  rows: string[][];
}

export default function DataTable({ title, headers, rows }: DataTableProps) {
  return (
    <GlassCard className="overflow-hidden">
      {title && <div className="px-4 py-2.5 border-b border-border text-[13px] text-text-secondary">{title}</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} className="px-4 py-2 text-left text-xs font-medium text-text-muted border-b border-border">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="border-b border-border last:border-0 hover:bg-glass-hover transition-colors">
                {row.map((cell, ci) => (
                  <td key={ci} className="px-4 py-2 text-text-secondary tabular-nums">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </GlassCard>
  );
}

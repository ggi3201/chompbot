import { GlassCard } from "../ui";

/** The frame most canvas blocks share: a quiet card with an optional title. */
export default function CanvasCard({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <GlassCard className="px-4 py-3">
      {title && <div className="text-[13px] text-text-secondary mb-3">{title}</div>}
      {children}
    </GlassCard>
  );
}

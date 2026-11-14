// Alert / callout box — info, warning, success, error, tip.
import { AlertTriangle, CheckCircle2, Info, Lightbulb, XCircle, type LucideIcon } from "lucide-react";
import { GlassCard } from "../ui";

interface CalloutProps {
  variant?: "info" | "warning" | "success" | "error" | "tip";
  title?: string;
  message: string;
}

const VARIANTS: Record<string, { icon: LucideIcon; tone: string }> = {
  info: { icon: Info, tone: "text-text-secondary" },
  warning: { icon: AlertTriangle, tone: "text-accent-ink" },
  success: { icon: CheckCircle2, tone: "text-success" },
  error: { icon: XCircle, tone: "text-error" },
  tip: { icon: Lightbulb, tone: "text-text-secondary" },
};

const DEFAULT_VARIANT = VARIANTS.info;

export default function Callout({ variant, title, message }: CalloutProps) {
  const v = VARIANTS[variant ?? "info"] ?? DEFAULT_VARIANT;

  return (
    <GlassCard className="px-4 py-3 flex gap-3">
      <v.icon size={16} strokeWidth={1.5} className={`shrink-0 mt-0.5 ${v.tone}`} />
      <div className="min-w-0">
        {title && <div className="text-sm font-medium text-text-primary mb-0.5">{title}</div>}
        <div className="text-[13px] leading-relaxed text-text-secondary">{message}</div>
      </div>
    </GlassCard>
  );
}

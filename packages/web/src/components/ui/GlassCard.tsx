interface GlassCardProps {
  hover?: boolean;
  className?: string;
  children: React.ReactNode;
}

export default function GlassCard({ hover, className = "", children }: GlassCardProps) {
  return (
    <div
      className={`bg-glass rounded-lg border border-glass-border ${
        hover ? "transition-colors duration-150 hover:bg-glass-hover hover:border-glass-border-hover" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

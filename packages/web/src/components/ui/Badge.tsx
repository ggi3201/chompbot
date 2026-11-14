interface BadgeProps {
  color?: string;
  className?: string;
  children: React.ReactNode;
}

export default function Badge({ color, className = "", children }: BadgeProps) {
  return (
    <code
      className={`bg-raised border border-border text-text-secondary text-xs px-1.5 py-0.5 rounded-sm font-mono ${className}`}
      style={color ? { color, borderColor: `${color}33` } : undefined}
    >
      {children}
    </code>
  );
}

import { type ComponentPropsWithoutRef } from "react";

const variants = {
  primary: "bg-accent border border-transparent text-on-accent hover:bg-[#f5ad4d]",
  ghost: "bg-raised border border-border text-text-primary hover:bg-[#2a2a2d]",
  danger: "bg-error/10 border border-error/25 text-error hover:bg-error/15",
  outline: "bg-transparent border border-border text-text-secondary hover:bg-white/4 hover:text-text-primary",
} as const;

const sizes = {
  sm: "h-8 px-3 text-[13px] rounded-md",
  md: "h-9 px-4 text-sm rounded-md",
} as const;

interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export default function Button({
  variant = "ghost",
  size = "md",
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 cursor-pointer font-medium active:scale-[0.98] disabled:opacity-50 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

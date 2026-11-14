import { type ComponentPropsWithoutRef } from "react";

type InputAs = "input" | "textarea" | "select";

type InputProps<T extends InputAs = "input"> = {
  as?: T;
  className?: string;
} & ComponentPropsWithoutRef<T>;

const base =
  "bg-glass border border-border rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-white/24 outline-none transition-colors duration-150";

export default function Input<T extends InputAs = "input">({
  as,
  className = "",
  ...props
}: InputProps<T>) {
  const Component = (as || "input") as React.ElementType;
  return <Component className={`${base} ${className}`} {...props} />;
}

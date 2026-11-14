/** Chomp's status LED: amber while something is running now, a dim grey dot otherwise. */
export default function LiveDot({ live = true }: { live?: boolean }) {
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
        live ? "bg-accent shadow-[0_0_0_2px_rgba(242,163,58,0.16)]" : "bg-text-muted opacity-50"
      }`}
    />
  );
}

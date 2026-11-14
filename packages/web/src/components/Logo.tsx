export default function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className="shrink-0">
      <path
        fill="currentColor"
        d="M5 2h6.1a3.2 3.2 0 0 0 6.9 2.9V15a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Z"
      />
    </svg>
  );
}

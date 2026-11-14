import { motion, useReducedMotion, useTime, useTransform } from "motion/react";
import { FACETS } from "../../lib/birthright";

const TAU = Math.PI * 2;

/** Every fact the agent has settled becomes something in orbit around it. */
function Moon({ index, label, value, showLabel, spread, labelScale }: { index: number; label: string; value: string; showLabel: boolean; spread: number; labelScale: number }) {
  const time = useTime();
  const reduced = useReducedMotion();
  const rx = (118 + index * 17) * spread;
  const ry = (24 + index * 3.4) * spread;
  const tilt = ((index % 2 ? -1 : 1) * (5 + index * 2.1) * Math.PI) / 180;
  const secondsPerLap = 70 + index * 13;
  const phase = (index * 2.399963) % TAU;

  const angle = useTransform(time, (ms) => phase + (reduced ? 0 : ((ms / 1000) / secondsPerLap) * TAU));
  const x = useTransform(angle, (a) => Math.cos(a) * rx * Math.cos(tilt) - Math.sin(a) * ry * Math.sin(tilt));
  const y = useTransform(angle, (a) => Math.cos(a) * rx * Math.sin(tilt) + Math.sin(a) * ry * Math.cos(tilt));
  const near = useTransform(angle, (a) => (Math.sin(a) + 1) / 2);
  const opacity = useTransform(near, (n) => 0.42 + n * 0.58);
  const scale = useTransform(near, (n) => 0.82 + n * 0.28);
  // Behind the ring on the far side of the lap, in front of it on the near side.
  const zIndex = useTransform(near, (n) => (n > 0.5 ? 3 : 1));
  // A label crossing the ring would land on the name, so it fades while it passes.
  const labelOpacity = useTransform(x, (v) => Math.min(1, Math.max(0, (Math.abs(v) - 74) / 44)));

  return (
    <motion.div className="absolute left-1/2 top-1/2 size-0" style={{ x, y, zIndex, opacity, scale }} title={`${label}: ${value}`}>
      <motion.div
        className="flex w-max origin-[2px_50%] items-center gap-1.5 whitespace-nowrap"
        initial={{ opacity: 0, scale: 0.2, y: "-50%" }}
        animate={{ opacity: 1, scale: labelScale, y: "-50%" }}
        transition={{ type: "spring", stiffness: 26, damping: 9, mass: 1.2 }}
      >
        <span className="block size-1 rounded-full bg-accent-ink shadow-[0_0_8px_2px_rgba(245,181,94,0.55)]" />
        {showLabel && <motion.span style={{ opacity: labelOpacity }} className="font-mono text-[11px] leading-none text-text-secondary">{label}</motion.span>}
      </motion.div>
    </motion.div>
  );
}

interface FacetOrbitProps {
  facets: Record<string, string>;
  showLabels: boolean;
  spread: number;
  /** Undoes the scale the ring is drawn at, so labels stay readable when it shrinks. */
  labelScale: number;
}

export default function FacetOrbit({ facets, showLabels, spread, labelScale }: FacetOrbitProps) {
  const settled = FACETS.filter((facet) => facet.key !== "name" && facets[facet.key]);
  return (
    <div className="absolute inset-0" role="list" aria-label="What the agent has learned">
      {settled.map((facet) => (
        <div role="listitem" key={facet.key}>
          <Moon
            index={FACETS.findIndex((f) => f.key === facet.key)}
            label={facet.label}
            value={facets[facet.key]}
            showLabel={showLabels}
            spread={spread}
            labelScale={labelScale}
          />
        </div>
      ))}
    </div>
  );
}

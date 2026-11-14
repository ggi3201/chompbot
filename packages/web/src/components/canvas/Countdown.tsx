// Live countdown to a target date — deadlines, trips, events.

import { useState, useEffect } from "react";
import { GlassCard, LiveDot } from "../ui";
import { hue } from "./colors";

interface CountdownProps {
  title?: string;
  target: string; // ISO date string or parseable date
  color?: string;
  subtitle?: string;
}

function computeDiff(target: string) {
  const diff = new Date(target).getTime() - Date.now();
  if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return { days, hours, minutes, seconds, expired: false };
}

export default function Countdown({ title, target, color, subtitle }: CountdownProps) {
  const [time, setTime] = useState(() => computeDiff(target));

  useEffect(() => {
    if (time.expired) return;
    const id = setInterval(() => setTime(computeDiff(target)), 1000);
    return () => clearInterval(id);
  }, [target, time.expired]);

  const units = [
    { label: "days", value: time.days },
    { label: "hours", value: time.hours },
    { label: "min", value: time.minutes },
    { label: "sec", value: time.seconds },
  ];

  return (
    <GlassCard className="px-4 py-3">
      {title && (
        <div className="flex items-center gap-2 mb-3 text-[13px] text-text-secondary">
          <LiveDot live={!time.expired} />
          {title}
        </div>
      )}

      <div className="flex justify-center gap-2">
        {units.map((u) => (
          <div key={u.label} className="flex flex-col items-center bg-raised rounded-md px-3 py-2 min-w-14">
            <span
              className="font-mono text-xl font-medium text-text-primary tabular-nums"
              style={color ? { color: hue(color) } : undefined}
            >
              {String(u.value).padStart(2, "0")}
            </span>
            <span className="font-mono text-[11px] text-text-muted mt-0.5">{u.label}</span>
          </div>
        ))}
      </div>

      {time.expired && <div className="text-center mt-2 text-[13px] text-text-secondary">Arrived</div>}

      {subtitle && !time.expired && <div className="text-center mt-2 text-xs text-text-muted">{subtitle}</div>}
    </GlassCard>
  );
}

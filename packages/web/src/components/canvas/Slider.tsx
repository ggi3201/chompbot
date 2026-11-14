// Interactive slider — local state; with `submitLabel` it also sends the chosen value to the agent.

import { useState } from "react";
import { Button } from "../ui";
import CanvasCard from "./CanvasCard";
import { useCanvasAction, useCanvasLocked } from "./CanvasActionContext";
import { hue } from "./colors";

interface SliderProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  color?: string;
  submitLabel?: string;
}

export default function Slider({
  label,
  value: initialValue,
  min = 0,
  max = 100,
  step = 1,
  unit = "",
  color,
  submitLabel,
}: SliderProps) {
  const send = useCanvasAction();
  const locked = useCanvasLocked();
  const [value, setValue] = useState(initialValue);
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <CanvasCard>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <span className="text-[13px] text-text-secondary">{label}</span>
        <span className="font-mono text-[13px] text-text-primary tabular-nums">
          {value}{unit}
        </span>
      </div>
      <div className="relative">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          className="w-full h-1.5 appearance-none bg-transparent cursor-pointer relative z-10
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:size-4
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-text-primary
            [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-glass
            [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-text-primary
            [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-glass
            [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:h-1.5
            [&::-moz-range-track]:rounded-full [&::-moz-range-track]:h-1.5"
        />
        <div className="absolute top-1/2 -translate-y-1/2 left-0 h-1.5 rounded-full pointer-events-none bg-raised w-full" />
        <div
          className="absolute top-1/2 -translate-y-1/2 left-0 h-1.5 rounded-full pointer-events-none"
          style={{ width: `${pct}%`, backgroundColor: hue(color) }}
        />
      </div>
      <div className="flex justify-between mt-1.5">
        <span className="font-mono text-[11px] text-text-muted tabular-nums">{min}{unit}</span>
        <span className="font-mono text-[11px] text-text-muted tabular-nums">{max}{unit}</span>
      </div>
      {submitLabel && (
        <Button className="mt-3" variant="outline" size="sm" disabled={!send || locked} onClick={() => send?.(`${label}: ${value}${unit}`)}>
          {submitLabel}
        </Button>
      )}
    </CanvasCard>
  );
}

// Vertical timeline — events, milestones, schedules, deployment history.

import CanvasCard from "./CanvasCard";
import { hue } from "./colors";

interface TimelineEvent {
  time?: string;
  title: string;
  description?: string;
  color?: string;
  icon?: string; // emoji
}

interface TimelineProps {
  title?: string;
  events: TimelineEvent[];
  color?: string;
}

// Dots stay grey unless the block or the event names a hue.
const NEUTRAL_DOT = "#85858b";

export default function Timeline({ title, events, color }: TimelineProps) {
  if (!events.length) return null;

  return (
    <CanvasCard title={title}>
      <div className="relative">
        {/* Centred on the 10px dots */}
        <div className="absolute left-[4.5px] top-2 bottom-2 w-px bg-border" />

        {events.map((event, i) => (
          <div key={i} className="relative pl-6 pb-4 last:pb-0">
            <div
              className="absolute left-0 top-1.5 size-2.5 rounded-full"
              style={{ backgroundColor: hue(event.color ?? color, NEUTRAL_DOT) }}
            />
            {event.time && <div className="font-mono text-xs text-text-muted mb-0.5">{event.time}</div>}
            <div className="text-sm font-medium text-text-primary">
              {event.icon && <span className="mr-1.5">{event.icon}</span>}
              {event.title}
            </div>
            {event.description && (
              <div className="text-[13px] text-text-muted mt-0.5 leading-relaxed">{event.description}</div>
            )}
          </div>
        ))}
      </div>
    </CanvasCard>
  );
}

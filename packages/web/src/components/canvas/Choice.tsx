// Pick one: the chosen option is sent as the user's next message.

import { useState } from "react";
import CanvasCard from "./CanvasCard";
import { useCanvasAction, useCanvasLocked } from "./CanvasActionContext";

interface Option {
  label: string;
  value?: string;
}

export default function Choice({ title, options }: { title?: string; options: Option[] }) {
  const send = useCanvasAction();
  const locked = useCanvasLocked();
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <CanvasCard title={title}>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            disabled={!send || locked || picked !== null}
            onClick={() => {
              send?.(o.value || o.label);
              setPicked(o.label);
            }}
            className={`h-8 px-3 rounded-md border text-[13px] cursor-pointer transition-colors disabled:cursor-default ${
              picked === o.label
                ? "bg-raised border-white/14 text-text-primary"
                : "bg-transparent border-border text-text-secondary enabled:hover:text-text-primary enabled:hover:border-white/14 disabled:opacity-50"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </CanvasCard>
  );
}

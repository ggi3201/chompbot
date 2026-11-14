// Button that answers the agent: click sends `prompt` (or the label) as the user's next message.

import { useState } from "react";
import { Button } from "../ui";
import { useCanvasAction, useCanvasLocked } from "./CanvasActionContext";

interface ActionButtonProps {
  label: string;
  prompt?: string;
  variant?: "primary" | "ghost" | "outline" | "danger";
}

export default function ActionButton({ label, prompt, variant = "ghost" }: ActionButtonProps) {
  const send = useCanvasAction();
  const locked = useCanvasLocked();
  const [sent, setSent] = useState(false);

  return (
    <div>
      <Button
        variant={variant}
        disabled={!send || sent || locked}
        title={send ? undefined : "Only works in chat"}
        onClick={() => {
          send?.(prompt || label);
          setSent(true);
        }}
      >
        {label}
      </Button>
    </div>
  );
}

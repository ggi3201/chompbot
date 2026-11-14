import { ThinkingOrb, type OrbSize, type OrbState } from "thinking-orbs";

interface AgentOrbProps {
  state: OrbState;
  size?: OrbSize;
}

/** An agent at work. The ink is pinned to light because the app is dark whatever the OS asks for. */
export default function AgentOrb({ state, size = 20 }: AgentOrbProps) {
  return <ThinkingOrb state={state} size={size} theme="dark" className="shrink-0" />;
}

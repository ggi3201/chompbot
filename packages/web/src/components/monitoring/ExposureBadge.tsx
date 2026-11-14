import type { Exposure } from "../../hooks/useMonitoring";
import { Badge } from "../ui";

export const EXPOSURE_LABELS = {
  "public-direct": "Public, direct",
  "public-tunnel": "Public, tunnel",
  lan: "LAN",
  tailnet: "Tailnet",
  local: "Local",
} as const satisfies Record<Exposure, string>;

// Colour marks how far a service reaches: red where the home IP shows, amber for the tunnel, blue for the tailnet.
// LAN and local stay neutral.
const colors: Record<Exposure, string | undefined> = {
  "public-direct": "#e5484d",
  "public-tunnel": "#f2a33a",
  lan: undefined,
  tailnet: "#3f88d4",
  local: undefined,
};

export default function ExposureBadge({ exposure }: { exposure: Exposure | null }) {
  if (!exposure) return null;
  return <Badge color={colors[exposure]}>{EXPOSURE_LABELS[exposure]}</Badge>;
}

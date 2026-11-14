import type { Targets, UrlTarget } from "./types.ts";

// The scheduler reserves one subrequest per port, so the list must leave room for URLs.
export const MAX_PORTS = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const isHttpUrl = (value: unknown): value is string => {
  if (!isText(value) || !URL.canParse(value)) return false;
  return ["http:", "https:"].includes(new URL(value).protocol);
};

const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

const isUrlTarget = (value: unknown): value is UrlTarget =>
  isRecord(value) &&
  isText(value.key) &&
  isHttpUrl(value.url) &&
  (value.expectedStatus === undefined || isInteger(value.expectedStatus, 100, 599));

/** Returns null for a missing list or one that does not match the contract. */
export function parseTargets(raw: string | null): Targets | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { version, urls, ports, homeHost } = value;
  if (
    typeof version !== "number" ||
    !Array.isArray(urls) ||
    !urls.every(isUrlTarget) ||
    !Array.isArray(ports) ||
    ports.length > MAX_PORTS ||
    !ports.every((port) => isInteger(port, 1, 65535)) ||
    !isText(homeHost)
  ) {
    return null;
  }
  return { version, urls, ports, homeHost };
}

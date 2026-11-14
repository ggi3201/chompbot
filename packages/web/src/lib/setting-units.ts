/** Settings store raw units (ms, bytes); the UI shows them as minutes and MB. */
export function displayFromRaw(raw: string, factor: number): string {
  return String(Math.round((Number(raw) / factor) * 100) / 100);
}

export function rawFromDisplay(display: string, factor: number): string {
  return String(Math.round(Number(display) * factor));
}

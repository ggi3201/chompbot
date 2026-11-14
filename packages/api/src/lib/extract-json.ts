/** Strip markdown code fences from an LLM response and return the raw JSON string */
export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenced) return fenced[1].trim();
  return raw.trim();
}

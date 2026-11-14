import { useState, useCallback } from "react";
import { apiFetch } from "../lib/api";

interface UseGenerateReturn<T = Record<string, unknown>> {
  generate: (prompt: string) => Promise<T | null>;
  loading: boolean;
  error: string | null;
}

export function useGenerate<T = Record<string, unknown>>(entityType: string): UseGenerateReturn<T> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(
    async (prompt: string): Promise<T | null> => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(`/generate/${entityType}`, {
          method: "POST",
          body: JSON.stringify({ prompt }),
        });
        const data = await res.json();

        if (!res.ok) {
          if (res.status === 422 && data.generated) {
            setError(data.error);
            return data.generated as T;
          }
          setError(data.error ?? `Generation failed (${res.status})`);
          return null;
        }

        return data.generated as T;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Generation failed");
        return null;
      } finally {
        setLoading(false);
      }
    },
    [entityType],
  );

  return { generate, loading, error };
}

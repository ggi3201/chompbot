import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../lib/api";

export function useCrud<T extends { id: string }>(endpoint: string) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(endpoint);
      if (!res.ok) throw new Error(`Failed to fetch ${endpoint}`);
      setItems(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function create(data: Partial<T>): Promise<T | null> {
    try {
      const res = await apiFetch(endpoint, {
        method: "POST",
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error ?? "Create failed");
        return null;
      }
      const created = await res.json();
      await refresh();
      return created;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
      return null;
    }
  }

  async function update(id: string, data: Partial<T>): Promise<T | null> {
    try {
      const res = await apiFetch(`${endpoint}/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error ?? "Update failed");
        return null;
      }
      const updated = await res.json();
      await refresh();
      return updated;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
      return null;
    }
  }

  async function remove(id: string): Promise<boolean> {
    try {
      const res = await apiFetch(`${endpoint}/${id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) {
        setError("Delete failed");
        return false;
      }
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      return false;
    }
  }

  return { items, loading, error, refresh, create, update, remove, setError };
}

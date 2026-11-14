export interface Plugin {
  id: string;
  name: string;
  version: string;
  description: string;
  source: string;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type NewPlugin = Omit<Plugin, "id" | "createdAt" | "updatedAt">;

export type CredentialType = "oauth" | "api-key" | "token";
export type ServiceStatus = "connected" | "disconnected" | "error";

export interface ServiceCredentials {
  type: CredentialType;
  data: Record<string, string>;
}

export interface ConnectedService {
  id: string;
  name: string;
  type: string;
  provider: string;
  credentials: ServiceCredentials;
  mcpServerConfig: Record<string, unknown>;
  status: ServiceStatus;
  createdAt: string;
  updatedAt: string;
}

export type NewConnectedService = Omit<ConnectedService, "id" | "createdAt" | "updatedAt">;

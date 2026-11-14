// The few Workers runtime types this project uses. Declared here to stay dependency-free.

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

declare module "cloudflare:sockets" {
  interface Socket {
    readonly opened: Promise<unknown>;
    close(): Promise<void>;
  }
  export function connect(address: { hostname: string; port: number }): Socket;
}

export interface UrlTarget {
  key: string;
  url: string;
  expectedStatus?: number;
}

export interface Targets {
  version: number;
  urls: UrlTarget[];
  ports: number[];
  homeHost: string;
}

export interface UrlResult {
  key: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
}

export interface PortResult {
  port: number;
  open: boolean;
}

export interface Report {
  ts: number;
  colo: string | null;
  vantage: "outside";
  results: UrlResult[];
  ports?: PortResult[];
}

export type Outcome = { ok: true } | { ok: false; error: string };

export interface Env {
  TARGETS: KVNamespace;
  CHOMP_RESULTS_URL: string;
  TELEGRAM_ALERTS_CHAT_ID: string;
  MONITOR_OUTSIDE_SECRET: string;
  TELEGRAM_ALERTS_BOT_TOKEN: string;
}
